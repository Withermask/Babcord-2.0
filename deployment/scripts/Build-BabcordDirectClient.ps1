[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$PublicOrigin,
    [Parameter(Mandatory = $true)][string]$HomeIPv4,
    [string]$DirectConfigFile,
    [string]$Version
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if (-not (Test-BabcordPublicIPv4 -Address $HomeIPv4)) {
    throw 'HomeIPv4 must be a publicly routable IPv4 address.'
}
$originUri = $null
if (-not [Uri]::TryCreate($PublicOrigin, [UriKind]::Absolute, [ref]$originUri) -or
    $originUri.Scheme -ne 'https' -or -not [string]::IsNullOrWhiteSpace($originUri.PathAndQuery.Trim('/'))) {
    throw 'PublicOrigin must be one HTTPS origin with no path, query, or fragment.'
}
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$owner = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_OWNER' -Required
$repository = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_REPOSITORY' -Required
$branch = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_BRANCH' -Default 'main'
$releasesPath = (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_RELEASES_PATH' -Default 'releases').Replace('\', '/').Trim('/')
$manifestPath = (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_MANIFEST_PATH' -Default "$releasesPath/latest.json").Replace('\', '/').Trim('/')
foreach ($value in @($owner, $repository, $branch, $releasesPath, $manifestPath)) {
    if ($value -notmatch '^[A-Za-z0-9._/-]+$' -or $value.Contains('..')) { throw "Unsupported GitHub release value: $value" }
}

$repositoryRoot = Get-BabcordRepositoryRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'package.json') | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }
$builder = Join-Path $repositoryRoot 'scripts\build-portable-client.mjs'
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw "Portable client builder is missing: $builder" }
$node = Get-BabcordNodePath

$descriptorUrl = ConvertTo-BabcordGitHubRawUrl -Owner $owner -Repository $repository -Branch $branch -Path $manifestPath
$clientTemplate = ConvertTo-BabcordGitHubRawUrl -Owner $owner -Repository $repository -Branch $branch -Path "$releasesPath/clients/__SHA256__.html"
$arguments = @(
    $builder,
    '--api-origin', $originUri.GetLeftPart([UriPartial]::Authority),
    '--home-ip', $HomeIPv4,
    '--version', $Version,
    '--github-owner', $owner,
    '--github-repo', $repository,
    '--github-branch', $branch,
    '--descriptor-url', $descriptorUrl,
    '--client-url', $clientTemplate,
    '--output-dir', 'releases',
    '--launcher-output', 'client/Open Babcord.html'
)
Push-Location $repositoryRoot
try {
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'The portable client builder failed.' }
}
finally { Pop-Location }

$workspaceRelease = Join-Path $repositoryRoot 'releases'
$descriptorFile = Join-Path $workspaceRelease 'latest.json'
$descriptor = Get-Content -Raw -LiteralPath $descriptorFile | ConvertFrom-Json
if ([string]$descriptor.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'The generated update descriptor has an invalid SHA-256 value.' }
$immutableClient = Join-Path $workspaceRelease "clients\$($descriptor.sha256).html"
if (-not (Test-Path -LiteralPath $immutableClient -PathType Leaf)) { throw 'The generated immutable client is missing.' }

$actualHash = (Get-FileHash -LiteralPath $immutableClient -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne [string]$descriptor.sha256) { throw 'Generated client hash verification failed.' }
$outputDirectory = Get-BabcordDirectOutputDirectory -Settings $settings
$outputClients = Join-Path $outputDirectory 'clients'
New-Item -ItemType Directory -Force -Path $outputClients | Out-Null
Copy-Item -LiteralPath $immutableClient -Destination (Join-Path $outputClients "$actualHash.html") -Force
Copy-Item -LiteralPath $descriptorFile -Destination (Join-Path $outputDirectory 'latest.json') -Force
Copy-Item -LiteralPath (Join-Path $workspaceRelease 'Open Babcord.html') -Destination (Join-Path $outputDirectory 'Open Babcord.html') -Force

[pscustomobject]@{
    Sha256 = $actualHash
    ClientFile = $immutableClient
    DescriptorFile = $descriptorFile
    LauncherFile = Join-Path $repositoryRoot 'client\Open Babcord.html'
    PublicOrigin = $originUri.GetLeftPart([UriPartial]::Authority)
    HomeIPv4 = $HomeIPv4
}

