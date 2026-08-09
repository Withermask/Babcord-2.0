[CmdletBinding()]
param(
    [string]$ConfigFile,
    [switch]$SkipPrune,
    [switch]$KeepApplicationRunning
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$nodePath = Get-BabcordNodePath
if (-not (Test-Path -LiteralPath $context.DatabasePath -PathType Leaf)) {
    throw "Babcord database was not found: $($context.DatabasePath)"
}
if ($context.BackupRetentionDays -lt 1 -or $context.BackupRetentionDays -gt 365) {
    throw 'BABCORD_BACKUP_RETENTION_DAYS must be from 1 through 365.'
}

$maintenanceMarker = Enter-BabcordMaintenance -Context $context -Operation 'backup'
$restartApplication = $false
try {
$restartApplication = -not $KeepApplicationRunning -and (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2)
if ($restartApplication) {
    Write-Host 'Pausing Babcord briefly so the database and attachments form one consistent snapshot...'
    & (Join-Path $PSScriptRoot 'Stop-Babcord.ps1') -ConfigFile $context.ConfigFile -KeepTunnel
    if (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2) {
        throw 'Babcord did not stop cleanly enough for a consistent backup.'
    }
}

New-Item -ItemType Directory -Force -Path $context.BackupDir | Out-Null
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$finalName = "babcord-backup-$timestamp-$suffix"
$finalPath = Join-Path $context.BackupDir $finalName
$null = Assert-BabcordChildPath -Parent $context.BackupDir -Child $finalPath -Label 'Backup path'

New-Item -ItemType Directory -Path $finalPath | Out-Null
$incompleteMarker = Join-Path $finalPath '.incomplete'
'Babcord backup is still being created. Do not restore it.' | Set-Content -LiteralPath $incompleteMarker -Encoding UTF8
try {
    $snapshotData = Join-Path $finalPath 'data'
    New-Item -ItemType Directory -Path $snapshotData | Out-Null

    $databaseName = Split-Path -Leaf $context.DatabasePath
    $excludedDatabaseFiles = @($databaseName, "$databaseName-wal", "$databaseName-shm", "$databaseName-journal")
    $robocopyArguments = @(
        $context.DataDir
        $snapshotData
        '/E'
        '/COPY:DAT'
        '/DCOPY:DAT'
        '/R:2'
        '/W:1'
        '/XJ'
        '/NFL'
        '/NDL'
        '/NJH'
        '/NJS'
        '/NP'
        '/XF'
    ) + $excludedDatabaseFiles
    & robocopy.exe @robocopyArguments | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
        throw "Copying Babcord data into the snapshot failed (robocopy exit code $copyExitCode)."
    }

    $databaseRelativePath = Get-BabcordRelativePath -Parent $context.DataDir -Child $context.DatabasePath
    $snapshotDatabase = Join-Path $snapshotData $databaseRelativePath
    $snapshotDatabaseParent = Split-Path -Parent $snapshotDatabase
    New-Item -ItemType Directory -Force -Path $snapshotDatabaseParent | Out-Null
    $backupHelper = Join-Path $script:BabcordDeploymentRoot 'helpers\sqlite-backup.mjs'
    & $nodePath $backupHelper $context.DatabasePath $snapshotDatabase | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'SQLite online backup failed.'
    }

    $databaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $snapshotDatabase).Hash.ToLowerInvariant()
    $files = @(Get-ChildItem -LiteralPath $snapshotData -File -Recurse -Force)
    $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $totalBytes) { $totalBytes = 0 }

    $appVersion = 'unknown'
    $serverPackagePath = Join-Path $context.RepositoryRoot 'server\package.json'
    if (Test-Path -LiteralPath $serverPackagePath -PathType Leaf) {
        try {
            $serverPackage = Get-Content -Raw -LiteralPath $serverPackagePath | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$serverPackage.version)) {
                $appVersion = [string]$serverPackage.version
            }
        }
        catch {
            $appVersion = 'unknown'
        }
    }

    [pscustomobject]@{
        format = 'babcord-windows-backup'
        formatVersion = 1
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        appVersion = $appVersion
        databaseRelativePath = $databaseRelativePath.Replace('\', '/')
        databaseSha256 = $databaseHash
        fileCount = $files.Count
        totalBytes = [long]$totalBytes
        logRetentionDays = [int](Get-BabcordSetting -Settings $context.Settings -Name 'BABCORD_LOG_RETENTION_DAYS' -Default '30')
        note = 'Sensitive disaster-recovery snapshot; protect access and enforce retention.'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $finalPath 'backup-manifest.json') -Encoding UTF8

    Remove-Item -LiteralPath $incompleteMarker -Force
    Write-Host "Backup completed: $finalPath" -ForegroundColor Green
}
catch {
    if (Test-Path -LiteralPath $finalPath) {
        $verifiedIncomplete = Assert-BabcordChildPath -Parent $context.BackupDir -Child $finalPath -Label 'Failed backup cleanup path'
        if ((Split-Path -Leaf $verifiedIncomplete) -match '^babcord-backup-\d{8}T\d{6}Z-[0-9a-f]{8}$' -and
            (Test-Path -LiteralPath (Join-Path $verifiedIncomplete '.incomplete') -PathType Leaf)) {
            Remove-Item -LiteralPath $verifiedIncomplete -Recurse -Force
        }
    }
    throw
}

if (-not $SkipPrune) {
    $cutoff = [DateTime]::UtcNow.AddDays(-$context.BackupRetentionDays)
    foreach ($candidate in Get-ChildItem -LiteralPath $context.BackupDir -Directory -Filter 'babcord-backup-*') {
        if ($candidate.Name -notmatch '^babcord-backup-\d{8}T\d{6}Z-[0-9a-f]{8}$') {
            continue
        }
        $manifestPath = Join-Path $candidate.FullName 'backup-manifest.json'
        if ((Test-Path -LiteralPath (Join-Path $candidate.FullName '.incomplete') -PathType Leaf) -or
            -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            continue
        }
        try {
            $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
            if ($manifest.format -ne 'babcord-windows-backup' -or [int]$manifest.formatVersion -ne 1) {
                Write-Warning "Skipped backup folder with an unrecognized manifest: $($candidate.FullName)"
                continue
            }
            $createdAt = [DateTime]::Parse([string]$manifest.createdAtUtc).ToUniversalTime()
        }
        catch {
            Write-Warning "Skipped unrecognized backup folder: $($candidate.FullName)"
            continue
        }
        if ($createdAt -ge $cutoff) {
            continue
        }

        $safeCandidate = Assert-BabcordChildPath -Parent $context.BackupDir -Child $candidate.FullName -Label 'Expired backup path'
        if ($safeCandidate.Equals($finalPath, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        Remove-Item -LiteralPath $safeCandidate -Recurse -Force
        Write-Host "Expired backup permanently removed: $safeCandidate"
    }
}
}
finally {
    Exit-BabcordMaintenance -Context $context -Marker $maintenanceMarker
    if ($restartApplication) {
        try {
            & (Join-Path $PSScriptRoot 'Start-Babcord.ps1') -ConfigFile $context.ConfigFile -SkipTunnel
        }
        catch {
            Write-Warning "The backup operation finished, but Babcord did not restart: $($_.Exception.Message)"
        }
    }
}
