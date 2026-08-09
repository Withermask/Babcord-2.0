[CmdletBinding()]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile,
    [string]$BootstrapAdminUsername,
    [string]$GitHubOwner,
    [string]$GitHubRepository,
    [string]$GitHubBranch = 'main',
    [switch]$InstallDependencies,
    [switch]$InstallCaddy,
    [switch]$ReplaceDirectConfiguration,
    [switch]$AcknowledgeNetworkRequirements
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator, then run this setup script again.'
}
if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = Get-BabcordDefaultConfigPath }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }

$nodePath = Get-BabcordNodePath
$resolvedConfig = Resolve-BabcordFullPath -Path $ConfigFile -Label 'Babcord configuration file'
if (-not (Test-Path -LiteralPath $resolvedConfig -PathType Leaf)) {
    $initializeArguments = @{
        ConfigFile = $resolvedConfig
        InstallDependencies = $InstallDependencies
    }
    if (-not [string]::IsNullOrWhiteSpace($BootstrapAdminUsername)) {
        $initializeArguments.BootstrapAdminUsername = $BootstrapAdminUsername
    }
    & (Join-Path $PSScriptRoot 'Initialize-BabcordHost.ps1') @initializeArguments
}
elseif ($InstallDependencies) {
    $serverDirectory = Join-Path (Get-BabcordRepositoryRoot) 'server'
    Push-Location $serverDirectory
    try {
        & npm.cmd ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Installing Babcord server dependencies failed.' }
    }
    finally { Pop-Location }
}

if ($InstallCaddy) {
    $existingCaddy = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if ($null -eq $existingCaddy) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($null -eq $winget) {
            throw 'Windows Package Manager (winget) was not found. Install Caddy 2 manually, then rerun setup without -InstallCaddy.'
        }
        & $winget.Source install --id CaddyServer.Caddy --exact --source winget --silent `
            --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw 'winget could not install CaddyServer.Caddy.' }
    }
}

$resolvedDirectConfig = Resolve-BabcordFullPath -Path $DirectConfigFile -Label 'Direct-host configuration file'
$directConfigDirectory = Split-Path -Parent $resolvedDirectConfig
New-Item -ItemType Directory -Force -Path $directConfigDirectory | Out-Null
if ((Test-Path -LiteralPath $resolvedDirectConfig -PathType Leaf) -and $ReplaceDirectConfiguration) {
    $preserved = "$resolvedDirectConfig.before-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $resolvedDirectConfig -Destination $preserved
    Write-Host "Previous direct-host configuration preserved at $preserved" -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $resolvedDirectConfig -PathType Leaf)) {
    $template = Join-Path (Split-Path -Parent $PSScriptRoot) 'direct-config.example.env'
    Copy-Item -LiteralPath $template -Destination $resolvedDirectConfig
}

$settingsRecord = Get-BabcordDirectSettings -DirectConfigFile $resolvedDirectConfig
$settings = $settingsRecord.Values
$caddyPath = Get-BabcordCaddyPath -Settings $settings
Set-BabcordEnvValue -Path $resolvedDirectConfig -Name 'BABCORD_DIRECT_CADDY_PATH' -Value $caddyPath
if (-not [string]::IsNullOrWhiteSpace($GitHubOwner)) {
    if ($GitHubOwner -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$') { throw 'GitHubOwner is not valid.' }
    Set-BabcordEnvValue -Path $resolvedDirectConfig -Name 'BABCORD_GITHUB_OWNER' -Value $GitHubOwner
}
if (-not [string]::IsNullOrWhiteSpace($GitHubRepository)) {
    if ($GitHubRepository -notmatch '^[A-Za-z0-9_.-]{1,100}$') { throw 'GitHubRepository is not valid.' }
    Set-BabcordEnvValue -Path $resolvedDirectConfig -Name 'BABCORD_GITHUB_REPOSITORY' -Value $GitHubRepository
}
if ($GitHubBranch -notmatch '^[A-Za-z0-9._/-]{1,200}$' -or $GitHubBranch.Contains('..')) { throw 'GitHubBranch is not valid.' }
Set-BabcordEnvValue -Path $resolvedDirectConfig -Name 'BABCORD_GITHUB_BRANCH' -Value $GitHubBranch

$settings = (Get-BabcordDirectSettings -DirectConfigFile $resolvedDirectConfig).Values
$stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings
$outputDirectory = Get-BabcordDirectOutputDirectory -Settings $settings
New-Item -ItemType Directory -Force -Path $stateDirectory, $outputDirectory | Out-Null

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($target in @($resolvedDirectConfig, $stateDirectory)) {
    $inheritance = if (Test-Path -LiteralPath $target -PathType Container) { '(OI)(CI)' } else { '' }
    & icacls.exe $target '/inheritance:r' "/grant:r" "${currentIdentity}:${inheritance}F" "SYSTEM:${inheritance}F" "BUILTIN\Administrators:${inheritance}F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Windows could not protect $target with the expected permissions." }
}

& (Join-Path $PSScriptRoot 'Set-BabcordFirewall.ps1') -ConfigFile $resolvedConfig -ApplyBlockRule -Confirm:$false
& (Join-Path $PSScriptRoot 'Set-BabcordDirectFirewall.ps1') -DirectConfigFile $resolvedDirectConfig -ApplyRules -Confirm:$false

Write-Host ''
Write-Host 'Babcord direct-host setup is ready.' -ForegroundColor Green
Write-Host "Node: $nodePath"
Write-Host "Caddy: $caddyPath"
Write-Host "Direct settings: $resolvedDirectConfig"
Write-Host 'Babcord remains on 127.0.0.1:8080. Only Caddy may accept public TCP 80/443.'
if (-not $AcknowledgeNetworkRequirements) {
    Write-Warning 'Before Start works publicly: confirm your router WAN address matches the detected public IPv4, confirm the ISP is not using CGNAT, and forward external TCP 80 and 443 to this Windows computer. Setup cannot change your router.'
}
Write-Host 'Next: configure GitHub fields, run Set-BabcordGitHubToken.ps1, then double-click Start Babcord Direct.bat.'

