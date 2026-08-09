[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [string]$ConfigFile
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$nodePath = Get-BabcordNodePath
$resolvedBackup = Resolve-BabcordFullPath -Path $BackupPath -Label 'BackupPath'
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Container)) {
    throw "Backup folder not found: $resolvedBackup"
}
if (Test-Path -LiteralPath (Join-Path $resolvedBackup '.incomplete') -PathType Leaf) {
    throw 'This backup is marked incomplete and cannot be restored.'
}
if ($resolvedBackup.Equals($context.DataDir, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedBackup.StartsWith($context.DataDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The restore source cannot be inside the live Babcord data directory.'
}

$manifestPath = Join-Path $resolvedBackup 'backup-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'This folder is not a recognized Babcord backup: backup-manifest.json is missing.'
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.format -ne 'babcord-windows-backup' -or [int]$manifest.formatVersion -ne 1) {
    throw 'This backup format is not supported by this restore script.'
}

$snapshotData = Join-Path $resolvedBackup 'data'
if (-not (Test-Path -LiteralPath $snapshotData -PathType Container)) {
    throw 'The backup data folder is missing.'
}
$relativeDatabase = ([string]$manifest.databaseRelativePath).Replace('/', '\')
$snapshotDatabase = Resolve-BabcordFullPath -Path (Join-Path $snapshotData $relativeDatabase) -Label 'Backup database'
$null = Assert-BabcordChildPath -Parent $snapshotData -Child $snapshotDatabase -Label 'Backup database'
if (-not (Test-Path -LiteralPath $snapshotDatabase -PathType Leaf)) {
    throw 'The backed-up SQLite database is missing.'
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $snapshotDatabase).Hash.ToLowerInvariant()
if ($actualHash -ne ([string]$manifest.databaseSha256).ToLowerInvariant()) {
    throw 'The backup database hash does not match its manifest. Restore was cancelled.'
}
$checkHelper = Join-Path $script:BabcordDeploymentRoot 'helpers\sqlite-check.mjs'
& $nodePath $checkHelper $snapshotDatabase | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'The backup database failed SQLite integrity checks. Restore was cancelled.'
}

if (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2) {
    throw 'Babcord is still running. Run Stop-Babcord.ps1 first, verify it is offline, then restore.'
}
$listeners = @(Get-BabcordTcpListeners -Port $context.Port)
if ($listeners.Count -gt 0) {
    throw "Port $($context.Port) still has a listener. Restore was cancelled to avoid replacing live data."
}

$expectedConfirmation = "RESTORE $($manifest.createdAtUtc)"
Write-Host ''
Write-Host 'WARNING: this will replace Babcord live data with the selected snapshot.' -ForegroundColor Red
Write-Host 'Current data will first be backed up and copied to a separate preserved folder.'
Write-Host "Backup: $resolvedBackup"
Write-Host "Created: $($manifest.createdAtUtc)"
Write-Host "Type exactly: $expectedConfirmation" -ForegroundColor Yellow
$confirmation = Read-Host 'Confirmation'
if ($confirmation -cne $expectedConfirmation) {
    throw 'Confirmation did not match. Nothing was changed.'
}

$maintenanceMarker = Enter-BabcordMaintenance -Context $context -Operation 'restore'
try {
if (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2) {
    throw 'Babcord restarted while confirmation was pending. It was stopped again before restore can continue.'
}

if (Test-Path -LiteralPath $context.DatabasePath -PathType Leaf) {
    Write-Host 'Creating a safety backup of current data before restore...'
    & (Join-Path $PSScriptRoot 'Backup-Babcord.ps1') -ConfigFile $context.ConfigFile -SkipPrune
}
else {
    Write-Host 'No current SQLite database exists; there is no live database to safety-backup.' -ForegroundColor Yellow
}

$dataParent = Assert-BabcordManagedPath -Path (Split-Path -Parent $context.DataDir) -Label 'Data parent'
$restoreStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$stagingPath = Join-Path $dataParent "restore-staging-$restoreStamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$preservedPath = Join-Path $dataParent "data-before-restore-$restoreStamp"
$null = Assert-BabcordChildPath -Parent $dataParent -Child $stagingPath -Label 'Restore staging path'
$null = Assert-BabcordChildPath -Parent $dataParent -Child $preservedPath -Label 'Preserved data path'
if ((Test-Path -LiteralPath $stagingPath) -or (Test-Path -LiteralPath $preservedPath)) {
    throw 'A restore staging or preservation path already exists. Nothing was changed.'
}

New-Item -ItemType Directory -Path $stagingPath | Out-Null
try {
    & robocopy.exe $snapshotData $stagingPath '/E' '/COPY:DAT' '/DCOPY:DAT' '/R:2' '/W:1' '/XJ' '/NFL' '/NDL' '/NJH' '/NJS' '/NP' | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
        throw "Copying the restore snapshot failed (robocopy exit code $copyExitCode)."
    }

    $stagedDatabase = Join-Path $stagingPath $relativeDatabase
    & $nodePath $checkHelper $stagedDatabase | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'The staged database failed integrity checks.'
    }

    if (Test-Path -LiteralPath $context.DataDir) {
        New-Item -ItemType Directory -Path $preservedPath | Out-Null
        & robocopy.exe $context.DataDir $preservedPath '/E' '/COPY:DAT' '/DCOPY:DAT' '/R:2' '/W:1' '/XJ' '/NFL' '/NDL' '/NJH' '/NJS' '/NP' | Out-Null
        $preserveExitCode = $LASTEXITCODE
        if ($preserveExitCode -gt 7) {
            throw "Preserving the current live data failed (robocopy exit code $preserveExitCode)."
        }
        if (Test-Path -LiteralPath $context.DatabasePath -PathType Leaf) {
            $preservedDatabase = Join-Path $preservedPath (Get-BabcordRelativePath -Parent $context.DataDir -Child $context.DatabasePath)
            & $nodePath $checkHelper $preservedDatabase | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw 'The preserved current database failed integrity checks; live data was not changed.'
            }
        }
    }
    try {
        if (Test-Path -LiteralPath $context.DataDir) {
            $safeLiveData = Assert-BabcordChildPath -Parent $dataParent -Child $context.DataDir -Label 'Live data replacement path'
            Remove-Item -LiteralPath $safeLiveData -Recurse -Force
        }
        New-Item -ItemType Directory -Path $context.DataDir | Out-Null
        & robocopy.exe $stagingPath $context.DataDir '/E' '/COPY:DAT' '/DCOPY:DAT' '/R:2' '/W:1' '/XJ' '/NFL' '/NDL' '/NJH' '/NJS' '/NP' | Out-Null
        $liveCopyExitCode = $LASTEXITCODE
        if ($liveCopyExitCode -gt 7) {
            throw "Copying staged data into the live directory failed (robocopy exit code $liveCopyExitCode)."
        }
        $liveDatabase = Join-Path $context.DataDir $relativeDatabase
        & $nodePath $checkHelper $liveDatabase | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'The restored live database failed integrity checks.'
        }
    }
    catch {
        if (Test-Path -LiteralPath $context.DataDir) {
            $safeFailedData = Assert-BabcordChildPath -Parent $dataParent -Child $context.DataDir -Label 'Failed live restore path'
            Remove-Item -LiteralPath $safeFailedData -Recurse -Force
        }
        if (Test-Path -LiteralPath $preservedPath) {
            New-Item -ItemType Directory -Path $context.DataDir -Force | Out-Null
            & robocopy.exe $preservedPath $context.DataDir '/E' '/COPY:DAT' '/DCOPY:DAT' '/R:2' '/W:1' '/XJ' '/NFL' '/NDL' '/NJH' '/NJS' '/NP' | Out-Null
            if ($LASTEXITCODE -gt 7) {
                Write-Warning "Automatic rollback copy also failed (robocopy exit code $LASTEXITCODE). Use the preserved folder printed below."
            }
        }
        throw
    }

    if (Test-Path -LiteralPath $stagingPath) {
        $safeCompletedStaging = Assert-BabcordChildPath -Parent $dataParent -Child $stagingPath -Label 'Completed restore staging path'
        Remove-Item -LiteralPath $safeCompletedStaging -Recurse -Force
    }
}
catch {
    if (Test-Path -LiteralPath $stagingPath) {
        $safeStaging = Assert-BabcordChildPath -Parent $dataParent -Child $stagingPath -Label 'Restore staging cleanup path'
        Remove-Item -LiteralPath $safeStaging -Recurse -Force
    }
    throw
}

Write-Host 'Restore completed. Babcord remains stopped for verification.' -ForegroundColor Green
Write-Host "Previous live data was preserved at: $preservedPath" -ForegroundColor Yellow
Write-Host 'Run Start-Babcord.ps1, verify sign-in/messages/attachments, then retain the preserved folder until you are satisfied.'
}
finally {
    Exit-BabcordMaintenance -Context $context -Marker $maintenanceMarker
}
