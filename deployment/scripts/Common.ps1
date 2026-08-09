Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:BabcordDeploymentRoot = Split-Path -Parent $PSScriptRoot
$script:BabcordRepositoryRoot = Split-Path -Parent $script:BabcordDeploymentRoot

function Get-BabcordRepositoryRoot {
    return [System.IO.Path]::GetFullPath($script:BabcordRepositoryRoot)
}

function Get-BabcordDefaultConfigPath {
    if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        throw 'The ProgramData environment variable is unavailable.'
    }

    return Join-Path $env:ProgramData 'Babcord\config\babcord.env'
}

function Resolve-BabcordFullPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string]$Label = 'Path'
    )

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        throw "$Label must be an absolute path. Received: $Path"
    }

    return [System.IO.Path]::GetFullPath($expanded).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Assert-BabcordManagedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string]$Label = 'Managed path'
    )

    $resolved = Resolve-BabcordFullPath -Path $Path -Label $Label
    $root = [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')
    $blocked = @(
        $root,
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('ProgramFilesX86'),
        [Environment]::GetFolderPath('UserProfile'),
        (Get-BabcordRepositoryRoot)
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
        [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/')
    }

    foreach ($blockedPath in $blocked) {
        if ($resolved.Equals($blockedPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label resolves to a protected broad location: $resolved"
        }
    }

    if ($resolved.Length -lt 8) {
        throw "$Label is unexpectedly broad: $resolved"
    }

    return $resolved
}

function Assert-BabcordChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Parent,

        [Parameter(Mandatory = $true)]
        [string]$Child,

        [string]$Label = 'Child path'
    )

    $parentPath = Resolve-BabcordFullPath -Path $Parent -Label 'Parent path'
    $childPath = Resolve-BabcordFullPath -Path $Child -Label $Label
    $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar

    if (-not $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must remain inside $parentPath. Received: $childPath"
    }

    return $childPath
}

function Get-BabcordRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Parent,

        [Parameter(Mandatory = $true)]
        [string]$Child
    )

    $parentPath = Resolve-BabcordFullPath -Path $Parent -Label 'Relative path parent'
    $childPath = Assert-BabcordChildPath -Parent $parentPath -Child $Child -Label 'Relative path child'
    $parentWithSeparator = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    $parentUri = [Uri]::new($parentWithSeparator)
    $childUri = [Uri]::new($childPath)
    $relative = [Uri]::UnescapeDataString($parentUri.MakeRelativeUri($childUri).ToString()).Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('..')) {
        throw "Could not derive a safe relative path from $parentPath to $childPath."
    }
    return $relative
}

function Read-BabcordEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $resolved = Resolve-BabcordFullPath -Path $Path -Label 'Configuration file'
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Babcord configuration was not found at $resolved. Run Initialize-BabcordHost.ps1 first."
    }

    $settings = [ordered]@{}
    $lineNumber = 0
    foreach ($rawLine in Get-Content -LiteralPath $resolved) {
        $lineNumber++
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) {
            continue
        }

        $separator = $line.IndexOf('=')
        if ($separator -lt 1) {
            throw "Invalid configuration line $lineNumber in $resolved."
        }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($name -notmatch '^[A-Z][A-Z0-9_]*$') {
            throw "Invalid setting name '$name' on line $lineNumber."
        }

        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        $settings[$name] = $value
    }

    return $settings
}

function Get-BabcordSetting {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Settings,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [string]$Default = $null,

        [switch]$Required
    )

    if ($Settings.Contains($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Settings[$Name])) {
        return [string]$Settings[$Name]
    }

    if ($Required) {
        throw "Required setting $Name is missing."
    }

    return $Default
}

function Get-BabcordContext {
    param(
        [string]$ConfigFile = (Get-BabcordDefaultConfigPath)
    )

    $configPath = Resolve-BabcordFullPath -Path $ConfigFile -Label 'Configuration file'
    $settings = Read-BabcordEnvFile -Path $configPath
    $dataDir = Assert-BabcordManagedPath -Path (
        Get-BabcordSetting -Settings $settings -Name 'BABCORD_DATA_DIR' -Required
    ) -Label 'BABCORD_DATA_DIR'
    $databasePath = Resolve-BabcordFullPath -Path (
        Get-BabcordSetting -Settings $settings -Name 'BABCORD_DATABASE_PATH' -Default (Join-Path $dataDir 'babcord.sqlite')
    ) -Label 'BABCORD_DATABASE_PATH'
    $null = Assert-BabcordChildPath -Parent $dataDir -Child $databasePath -Label 'BABCORD_DATABASE_PATH'
    $backupDir = Assert-BabcordManagedPath -Path (
        Get-BabcordSetting -Settings $settings -Name 'BABCORD_BACKUP_DIR' -Required
    ) -Label 'BABCORD_BACKUP_DIR'
    if ($backupDir.StartsWith($dataDir + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $dataDir.StartsWith($backupDir + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $backupDir.Equals($dataDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'BABCORD_BACKUP_DIR and BABCORD_DATA_DIR must be separate, non-nested folders.'
    }
    $logDir = Assert-BabcordManagedPath -Path (
        Get-BabcordSetting -Settings $settings -Name 'BABCORD_LOG_DIR' -Default (Join-Path (Split-Path $dataDir -Parent) 'logs')
    ) -Label 'BABCORD_LOG_DIR'
    $stateDir = Assert-BabcordManagedPath -Path (
        Get-BabcordSetting -Settings $settings -Name 'BABCORD_STATE_DIR' -Default (Join-Path (Split-Path $dataDir -Parent) 'state')
    ) -Label 'BABCORD_STATE_DIR'
    $portText = Get-BabcordSetting -Settings $settings -Name 'BABCORD_PORT' -Default '8080'
    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
        throw "BABCORD_PORT must be an integer from 1024 through 65535. Received: $portText"
    }

    $hostAddress = Get-BabcordSetting -Settings $settings -Name 'BABCORD_HOST' -Default '127.0.0.1'
    if ($hostAddress -notin @('127.0.0.1', '::1', 'localhost')) {
        throw "BABCORD_HOST must be loopback-only (127.0.0.1, ::1, or localhost). Received: $hostAddress"
    }

    return [pscustomobject]@{
        ConfigFile = $configPath
        Settings = $settings
        RepositoryRoot = Get-BabcordRepositoryRoot
        DataDir = $dataDir
        DatabasePath = $databasePath
        BackupDir = $backupDir
        LogDir = $logDir
        StateDir = $stateDir
        Port = $port
        HostAddress = $hostAddress
        LocalHealthUrl = "http://127.0.0.1:$port/health"
        PublicUrl = Get-BabcordSetting -Settings $settings -Name 'BABCORD_PUBLIC_URL' -Default 'https://babcord.withermask.net'
        BackupRetentionDays = [int](Get-BabcordSetting -Settings $settings -Name 'BABCORD_BACKUP_RETENTION_DAYS' -Default '14')
        ServerEntry = Get-BabcordSetting -Settings $settings -Name 'BABCORD_SERVER_ENTRY' -Default 'server/src/index.mjs'
    }
}

function Get-BabcordNodePath {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command node -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw 'Node.js was not found. Install the current Node.js 24 LTS release, then reopen PowerShell.'
    }

    $versionText = (& $command.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(?<major>\d+)\.') {
        throw "Unable to determine the Node.js version at $($command.Source)."
    }
    if ([int]$Matches.major -lt 24) {
        throw "Babcord requires Node.js 24 or newer. Found $versionText."
    }

    return $command.Source
}

function Start-BabcordNodeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath
    )

    $startParameters = @{
        FilePath = $NodePath
        ArgumentList = $Arguments
        WorkingDirectory = $WorkingDirectory
        RedirectStandardOutput = $StandardOutputPath
        RedirectStandardError = $StandardErrorPath
        WindowStyle = 'Hidden'
        PassThru = $true
    }

    try {
        return Start-Process @startParameters
    }
    catch [ArgumentException] {
        # Some managed launch environments inject both Path and PATH. Windows
        # PowerShell's Start-Process rejects that duplicate even though Windows
        # itself accepts it. Remove only the duplicate spelling and retry once.
        if ($_.Exception.Message -notmatch "already been added.*('Path'|'PATH')") {
            throw
        }
        [Environment]::SetEnvironmentVariable('Path', $null, [EnvironmentVariableTarget]::Process)
        return Start-Process @startParameters
    }
}

function Get-BabcordPidFile {
    param([Parameter(Mandatory = $true)]$Context)
    return Join-Path $Context.StateDir 'babcord.pid.json'
}

function Get-BabcordMaintenanceMarkers {
    param([Parameter(Mandatory = $true)]$Context)
    if (-not (Test-Path -LiteralPath $Context.StateDir -PathType Container)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $Context.StateDir -File -Filter '*.maintenance.json' -ErrorAction SilentlyContinue)
}

function Enter-BabcordMaintenance {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Operation
    )

    New-Item -ItemType Directory -Force -Path $Context.StateDir | Out-Null
    $marker = Join-Path $Context.StateDir "$Operation.maintenance.json"
    $null = Assert-BabcordChildPath -Parent $Context.StateDir -Child $marker -Label 'Maintenance marker'
    if (Test-Path -LiteralPath $marker -PathType Leaf) {
        try {
            $existing = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
            $createdAt = [DateTime]::Parse([string]$existing.createdAtUtc).ToUniversalTime()
            throw "Babcord $Operation maintenance is already marked in progress since $createdAt. Inspect the corresponding task/process before touching its marker."
        }
        catch {
            if ($_.Exception.Message -like 'Babcord * maintenance is already marked*') {
                throw
            }
            throw "An unreadable maintenance marker exists at $marker. Inspect it before removing it manually."
        }
    }

    New-Item -ItemType File -Path $marker -ErrorAction Stop | Out-Null
    [pscustomobject]@{
        operation = $Operation
        processId = $PID
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
    return $marker
}

function Exit-BabcordMaintenance {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$Marker
    )
    $safeMarker = Assert-BabcordChildPath -Parent $Context.StateDir -Child $Marker -Label 'Maintenance marker cleanup path'
    if ((Split-Path -Leaf $safeMarker) -notmatch '^[a-z0-9-]+\.maintenance\.json$') {
        throw "Refusing to remove an unrecognized maintenance marker: $safeMarker"
    }
    Remove-Item -LiteralPath $safeMarker -Force -ErrorAction SilentlyContinue
}

function Get-BabcordTrackedProcess {
    param([Parameter(Mandatory = $true)]$Context)

    $pidFile = Get-BabcordPidFile -Context $Context
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return $null
    }

    try {
        $record = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
        $processId = [int]$record.pid
        $process = Get-Process -Id $processId -ErrorAction Stop
        if ($process.ProcessName -ne 'node') {
            throw "PID $processId no longer belongs to Node.js; refusing to manage that process."
        }

        $recordedStart = [DateTime]::Parse([string]$record.startedAtUtc).ToUniversalTime()
        $actualStart = $process.StartTime.ToUniversalTime()
        if ([Math]::Abs(($recordedStart - $actualStart).TotalMinutes) -gt 2) {
            throw "PID $processId was reused by a newer process; refusing to manage it."
        }

        try {
            $actualExecutable = Resolve-BabcordFullPath -Path $process.Path -Label 'Tracked process executable'
            $recordedExecutable = Resolve-BabcordFullPath -Path ([string]$record.nodePath) -Label 'Recorded Node executable'
            if (-not $actualExecutable.Equals($recordedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
                throw "PID $processId uses a different Node.js executable; refusing to manage it."
            }
        }
        catch [System.ComponentModel.Win32Exception] {
            # Cross-account process paths can require elevation. Name + exact
            # start time + protected PID record still prevent PID-reuse errors.
        }

        return [pscustomobject]@{
            ProcessId = $process.Id
            Name = $process.ProcessName
            StartTime = $process.StartTime
        }
    }
    catch [System.ArgumentException] {
        return $null
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $null
    }
}

function Get-BabcordTcpListeners {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    }
    catch {
        return @(
            [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
                Where-Object { $_.Port -eq $Port } |
                ForEach-Object {
                    [pscustomobject]@{
                        LocalAddress = $_.Address.ToString()
                        LocalPort = $_.Port
                        OwningProcess = $null
                    }
                }
        )
    }
}

function Test-BabcordHealth {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,

        [int]$TimeoutSeconds = 4
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSeconds -Headers @{
            'Cache-Control' = 'no-cache'
            'User-Agent' = 'Babcord-Windows-Health-Monitor'
        }
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

function Test-BabcordAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-BabcordPidRecord {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$NodePath
    )

    New-Item -ItemType Directory -Force -Path $Context.StateDir | Out-Null
    $pidFile = Get-BabcordPidFile -Context $Context
    $temporary = "$pidFile.new"
    [pscustomobject]@{
        pid = $ProcessId
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
        nodePath = $NodePath
        repositoryRoot = $Context.RepositoryRoot
    } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $pidFile -Force
}

function Get-BabcordAppTaskName { return 'Babcord Application' }
function Get-BabcordMonitorTaskName { return 'Babcord Health Monitor' }
function Get-BabcordBackupTaskName { return 'Babcord Daily Backup' }
