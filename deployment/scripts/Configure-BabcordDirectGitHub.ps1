[CmdletBinding()]
param(
    [string]$DirectConfigFile,
    [string]$Owner,
    [string]$Repository,
    [string]$Branch = 'main',
    [switch]$SkipTokenPrompt
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$directConfig = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Path
if ([string]::IsNullOrWhiteSpace($Owner)) { $Owner = Read-Host 'GitHub account or organization name' }
if ([string]::IsNullOrWhiteSpace($Repository)) { $Repository = Read-Host 'Public GitHub repository name' }
if ([string]::IsNullOrWhiteSpace($Branch)) { $Branch = 'main' }
if ($Owner -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$') { throw 'The GitHub owner name is invalid.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]{1,100}$') { throw 'The GitHub repository name is invalid.' }
if ($Branch -notmatch '^[A-Za-z0-9._/-]{1,200}$' -or $Branch.Contains('..')) { throw 'The GitHub branch name is invalid.' }

try {
    $repositoryInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$([Uri]::EscapeDataString($Owner))/$([Uri]::EscapeDataString($Repository))" `
        -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Babcord-Direct-Host/1.0' } -TimeoutSec 20
    if ([bool]$repositoryInfo.private) {
        throw 'The repository is private. Babcord launchers must fetch updates without carrying a GitHub credential, so use a public repository containing client files only.'
    }
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$([Uri]::EscapeDataString($Owner))/$([Uri]::EscapeDataString($Repository))/branches/$([Uri]::EscapeDataString($Branch))" `
        -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Babcord-Direct-Host/1.0' } -TimeoutSec 20
}
catch {
    if ($_.Exception.Message -like 'The repository is private*') { throw }
    throw "The public GitHub repository and branch could not be verified. Create the repository with Add a README checked (so the $Branch branch exists), then try again. $($_.Exception.Message)"
}

Set-BabcordEnvValue -Path $directConfig -Name 'BABCORD_GITHUB_OWNER' -Value $Owner
Set-BabcordEnvValue -Path $directConfig -Name 'BABCORD_GITHUB_REPOSITORY' -Value $Repository
Set-BabcordEnvValue -Path $directConfig -Name 'BABCORD_GITHUB_BRANCH' -Value $Branch
Write-Host "GitHub client repository configured: $Owner/$Repository ($Branch)" -ForegroundColor Green
if (-not $SkipTokenPrompt) {
    & (Join-Path $PSScriptRoot 'Set-BabcordGitHubToken.ps1') -DirectConfigFile $directConfig
}
