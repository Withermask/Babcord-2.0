[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:ProgramData 'Babcord'),
    [string]$ConfigFile,
    [string]$BootstrapAdminUsername,
    [switch]$ReplaceConfiguration,
    [switch]$InstallDependencies
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator, then run this setup script again.'
}

$nodePath = Get-BabcordNodePath
$resolvedInstallRoot = Assert-BabcordManagedPath -Path $InstallRoot -Label 'InstallRoot'
if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Join-Path $resolvedInstallRoot 'config\babcord.env'
}
$resolvedConfigFile = Resolve-BabcordFullPath -Path $ConfigFile -Label 'ConfigFile'
$null = Assert-BabcordChildPath -Parent $resolvedInstallRoot -Child $resolvedConfigFile -Label 'ConfigFile'

$directories = [ordered]@{
    Config = Split-Path -Parent $resolvedConfigFile
    Data = Join-Path $resolvedInstallRoot 'data'
    Attachments = Join-Path $resolvedInstallRoot 'data\attachments'
    Avatars = Join-Path $resolvedInstallRoot 'data\avatars'
    ServerIcons = Join-Path $resolvedInstallRoot 'data\server-icons'
    Backups = Join-Path $resolvedInstallRoot 'backups'
    Exports = Join-Path $resolvedInstallRoot 'exports'
    Logs = Join-Path $resolvedInstallRoot 'logs'
    State = Join-Path $resolvedInstallRoot 'state'
    Cloudflared = Join-Path $resolvedInstallRoot 'cloudflared'
}

foreach ($entry in $directories.GetEnumerator()) {
    $safePath = Assert-BabcordManagedPath -Path $entry.Value -Label $entry.Key
    New-Item -ItemType Directory -Force -Path $safePath | Out-Null
}

if (Test-Path -LiteralPath $resolvedConfigFile -PathType Leaf) {
    if (-not $ReplaceConfiguration) {
        Write-Host "Existing private configuration kept: $resolvedConfigFile" -ForegroundColor Yellow
    }
    else {
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $preservedPath = "$resolvedConfigFile.before-$timestamp"
        Move-Item -LiteralPath $resolvedConfigFile -Destination $preservedPath
        Write-Host "Previous configuration preserved at $preservedPath" -ForegroundColor Yellow
    }
}

if (-not (Test-Path -LiteralPath $resolvedConfigFile -PathType Leaf)) {
    if ([string]::IsNullOrWhiteSpace($BootstrapAdminUsername)) {
        $BootstrapAdminUsername = Read-Host 'Choose the first global administrator username'
    }
    if ($BootstrapAdminUsername -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$') {
        throw 'The bootstrap username must be 3-32 characters and use letters, numbers, periods, underscores, or hyphens.'
    }

    function New-UrlSafeSecret {
        param([int]$Bytes)
        $buffer = [byte[]]::new($Bytes)
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $generator.GetBytes($buffer)
        }
        finally {
            $generator.Dispose()
        }
        return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }

    $sessionSecret = New-UrlSafeSecret -Bytes 48
    $recoveryPepper = New-UrlSafeSecret -Bytes 48
    $bootstrapPassword = New-UrlSafeSecret -Bytes 18
    $dataDir = $directories.Data
    $databasePath = Join-Path $dataDir 'babcord.sqlite'
    $configLines = @(
        'NODE_ENV=production'
        'BABCORD_HOST=127.0.0.1'
        'BABCORD_PORT=8080'
        'BABCORD_PUBLIC_URL=https://babcord.withermask.net'
        'BABCORD_WEB_ORIGIN=https://babcord.withermask.net'
        'BABCORD_SERVER_ENTRY=server/src/index.mjs'
        'BABCORD_CLIENT_DIR=.\client'
        "BABCORD_DATA_DIR=$dataDir"
        "BABCORD_DATABASE_PATH=$databasePath"
        "BABCORD_BACKUP_DIR=$($directories.Backups)"
        "BABCORD_EXPORT_DIR=$($directories.Exports)"
        "BABCORD_LOG_DIR=$($directories.Logs)"
        "BABCORD_STATE_DIR=$($directories.State)"
        'BABCORD_LOG_RETENTION_DAYS=30'
        'BABCORD_LOG_WARNING_DAYS=5'
        'BABCORD_LOG_WARNING_HOUR=9'
        'BABCORD_BACKUP_RETENTION_DAYS=14'
        'BABCORD_SESSION_DAYS=30'
        'BABCORD_REGISTRATION_RATE_LIMIT_PER_HOUR=30'
        'BABCORD_MAX_IMAGE_BYTES=5242880'
        'BABCORD_MAX_FILE_BYTES=10485760'
        "BABCORD_SECRET=$sessionSecret"
        "BABCORD_RECOVERY_PEPPER=$recoveryPepper"
        "BABCORD_ADMIN_USERNAME=$BootstrapAdminUsername"
        "BABCORD_ADMIN_PASSWORD=$bootstrapPassword"
    )
    $configLines | Set-Content -LiteralPath $resolvedConfigFile -Encoding UTF8

    Write-Host ''
    Write-Host 'IMPORTANT: save this one-time bootstrap password now.' -ForegroundColor Yellow
    Write-Host "Username: $BootstrapAdminUsername"
    Write-Host "Temporary password: $bootstrapPassword" -ForegroundColor Yellow
    Write-Host 'Sign in, save the recovery codes, change the password, then run Clear-BabcordBootstrapSecret.ps1.'
    Write-Host ''
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$aclTargets = @($resolvedInstallRoot, $directories.Config, $resolvedConfigFile, (Get-BabcordRepositoryRoot))
foreach ($target in $aclTargets) {
    $isDirectory = Test-Path -LiteralPath $target -PathType Container
    $inheritance = if ($isDirectory) { '(OI)(CI)' } else { '' }
    & icacls.exe $target '/inheritance:r' "/grant:r" "${currentIdentity}:${inheritance}F" "SYSTEM:${inheritance}F" "BUILTIN\Administrators:${inheritance}F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not protect $target with the expected permissions."
    }
}

$context = Get-BabcordContext -ConfigFile $resolvedConfigFile
$serverEntryPath = Join-Path $context.RepositoryRoot $context.ServerEntry
if (-not (Test-Path -LiteralPath $serverEntryPath -PathType Leaf)) {
    Write-Warning "The server entry file is not present yet: $serverEntryPath"
}

if ($InstallDependencies) {
    $serverPackage = Join-Path $context.RepositoryRoot 'server\package.json'
    if (-not (Test-Path -LiteralPath $serverPackage -PathType Leaf)) {
        throw "Server package file not found: $serverPackage"
    }
    Push-Location (Split-Path -Parent $serverPackage)
    try {
        & npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) {
            throw 'Installing server dependencies failed.'
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host 'Babcord host folders and private configuration are ready.' -ForegroundColor Green
Write-Host "Node: $nodePath"
Write-Host "Configuration: $resolvedConfigFile"
Write-Host "Data: $($context.DataDir)"
Write-Host 'No public firewall port was opened.'
