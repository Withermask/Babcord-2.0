[CmdletBinding()]
param(
    [string]$DirectConfigFile,
    [string]$ClientFile,
    [string]$DescriptorFile,
    [string]$LauncherFile
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$owner = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_OWNER' -Required
$repository = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_REPOSITORY' -Required
$branch = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_BRANCH' -Default 'main'
$releasesPath = (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_RELEASES_PATH' -Default 'releases').Replace('\', '/').Trim('/')
$manifestPath = (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_MANIFEST_PATH' -Default "$releasesPath/latest.json").Replace('\', '/').Trim('/')
foreach ($value in @($owner, $repository, $branch, $releasesPath, $manifestPath)) {
    if ($value -notmatch '^[A-Za-z0-9._/-]+$' -or $value.Contains('..')) { throw "Unsupported GitHub publish value: $value" }
}

$outputDirectory = Get-BabcordDirectOutputDirectory -Settings $settings
if ([string]::IsNullOrWhiteSpace($DescriptorFile)) { $DescriptorFile = Join-Path $outputDirectory 'latest.json' }
$resolvedDescriptor = Resolve-BabcordFullPath -Path $DescriptorFile -Label 'Update descriptor'
if (-not (Test-Path -LiteralPath $resolvedDescriptor -PathType Leaf)) { throw "Update descriptor is missing: $resolvedDescriptor" }
$descriptor = Get-Content -Raw -LiteralPath $resolvedDescriptor | ConvertFrom-Json
$hash = [string]$descriptor.sha256
if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'The descriptor SHA-256 is invalid.' }
if ([string]::IsNullOrWhiteSpace($ClientFile)) { $ClientFile = Join-Path $outputDirectory "clients\$hash.html" }
$resolvedClient = Resolve-BabcordFullPath -Path $ClientFile -Label 'Immutable client'
if (-not (Test-Path -LiteralPath $resolvedClient -PathType Leaf)) { throw "Immutable client is missing: $resolvedClient" }
if ((Get-FileHash -LiteralPath $resolvedClient -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
    throw 'The client does not match the descriptor SHA-256; nothing was published.'
}
if ([string]::IsNullOrWhiteSpace($LauncherFile)) { $LauncherFile = Join-Path $outputDirectory 'Open Babcord.html' }
$resolvedLauncher = Resolve-BabcordFullPath -Path $LauncherFile -Label 'Permanent launcher'
if (-not (Test-Path -LiteralPath $resolvedLauncher -PathType Leaf)) { throw "Permanent launcher is missing: $resolvedLauncher" }

$defaultTokenFile = Join-Path $env:ProgramData 'Babcord\config\github-token.txt'
$tokenFile = Resolve-BabcordFullPath -Path (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_TOKEN_FILE' -Default $defaultTokenFile) -Label 'GitHub token file'
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
    throw "GitHub token file is missing. Run Set-BabcordGitHubToken.ps1 first: $tokenFile"
}
$token = [IO.File]::ReadAllText($tokenFile).Trim()
if ($token.Length -lt 20 -or $token -match '\s') { throw 'The stored GitHub token does not look valid.' }
$headers = @{
    Accept = 'application/vnd.github+json'
    Authorization = "Bearer $token"
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'Babcord-Direct-Host/1.0'
}

function ConvertTo-GitHubApiPath {
    param([Parameter(Mandatory = $true)][string]$Value)
    return (($Value.Replace('\', '/').Split('/') | Where-Object { $_.Length -gt 0 } | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')
}

function Get-GitHubContentRecord {
    param([Parameter(Mandatory = $true)][string]$RemotePath)
    $apiPath = ConvertTo-GitHubApiPath -Value $RemotePath
    $uri = "https://api.github.com/repos/$([Uri]::EscapeDataString($owner))/$([Uri]::EscapeDataString($repository))/contents/$apiPath?ref=$([Uri]::EscapeDataString($branch))"
    try {
        return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 20
    }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($status -eq 404) { return $null }
        throw
    }
}

function Publish-GitHubContent {
    param(
        [Parameter(Mandatory = $true)][string]$RemotePath,
        [Parameter(Mandatory = $true)][string]$LocalPath,
        [Parameter(Mandatory = $true)][string]$CommitMessage,
        [switch]$Immutable
    )
    $bytes = [IO.File]::ReadAllBytes($LocalPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $localHash = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
    $existing = Get-GitHubContentRecord -RemotePath $RemotePath
    if ($null -ne $existing -and [string]::IsNullOrWhiteSpace([string]$existing.content) -and $Immutable) {
        throw "Immutable GitHub path already exists but its content could not be verified through the Contents API: $RemotePath"
    }
    if ($null -ne $existing -and -not [string]::IsNullOrWhiteSpace([string]$existing.content)) {
        $remoteBytes = [Convert]::FromBase64String(([string]$existing.content).Replace("`n", '').Replace("`r", ''))
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $remoteHash = (($sha.ComputeHash($remoteBytes) | ForEach-Object { $_.ToString('x2') }) -join '') }
        finally { $sha.Dispose() }
        if ($remoteHash -eq $localHash) {
            Write-Host "GitHub already has the current file: $RemotePath"
            return
        }
        if ($Immutable) { throw "Immutable GitHub path already exists with different content: $RemotePath" }
    }
    $payload = [ordered]@{
        message = $CommitMessage
        content = [Convert]::ToBase64String($bytes)
        branch = $branch
    }
    if ($null -ne $existing) { $payload.sha = [string]$existing.sha }
    $apiPath = ConvertTo-GitHubApiPath -Value $RemotePath
    $uri = "https://api.github.com/repos/$([Uri]::EscapeDataString($owner))/$([Uri]::EscapeDataString($repository))/contents/$apiPath"
    $body = $payload | ConvertTo-Json -Depth 4
    $null = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
    Write-Host "Published: $RemotePath" -ForegroundColor Green
}

try {
    # Upload immutable content first. Only after that succeeds may launchers be
    # pointed at it by updating the small descriptor.
    Publish-GitHubContent -RemotePath "$releasesPath/clients/$hash.html" -LocalPath $resolvedClient `
        -CommitMessage "Publish Babcord client $hash" -Immutable
    Publish-GitHubContent -RemotePath "$releasesPath/Open Babcord.html" -LocalPath $resolvedLauncher `
        -CommitMessage 'Publish permanent Babcord launcher'
    Publish-GitHubContent -RemotePath $manifestPath -LocalPath $resolvedDescriptor `
        -CommitMessage "Point Babcord launcher to client $hash"
    Write-Host 'GitHub client update is published in race-safe order.' -ForegroundColor Green
}
finally {
    $token = $null
    $headers.Authorization = $null
}
