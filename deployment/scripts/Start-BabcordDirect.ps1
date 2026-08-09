[CmdletBinding()]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile,
    [switch]$SkipPublish,
    [switch]$SkipWatcher,
    [int]$PublicStartupTimeoutSeconds = 90
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = Get-BabcordDefaultConfigPath }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$context = Get-BabcordContext -ConfigFile $ConfigFile
$directRecord = Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile
$settings = $directRecord.Values
$publicIp = Get-BabcordPublicIPv4
$publicHost = Get-BabcordDirectPublicHost -Settings $settings -PublicIPv4 $publicIp
$publicOrigin = "https://$publicHost"
$owner = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_OWNER' -Default ''
$repository = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_REPOSITORY' -Default ''
$branch = Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_BRANCH' -Default 'main'
$releasesPath = (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_RELEASES_PATH' -Default 'releases').Replace('\', '/').Trim('/')
$configuredTokenFile = Resolve-BabcordFullPath -Path (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_TOKEN_FILE' -Default (Join-Path $env:ProgramData 'Babcord\config\github-token.txt')) -Label 'GitHub token file'
if (-not $SkipPublish) {
    if ([string]::IsNullOrWhiteSpace($owner) -or [string]::IsNullOrWhiteSpace($repository)) {
        throw 'GitHub client publishing is not configured. Run Configure Babcord GitHub.bat before the one-click start, or use -SkipPublish only for deliberate diagnostics.'
    }
    if (-not (Test-Path -LiteralPath $configuredTokenFile -PathType Leaf)) {
        throw 'The protected GitHub token file is missing. Run Configure Babcord GitHub.bat or Set-BabcordGitHubToken.ps1 before the one-click start.'
    }
}

$parsedPublicHostIp = $null
$publicHostIsIp = [Net.IPAddress]::TryParse($publicHost, [ref]$parsedPublicHostIp)
if (-not $publicHostIsIp) {
    try {
        $resolvedAddresses = [Net.Dns]::GetHostAddresses($publicHost) |
            Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } |
            ForEach-Object { $_.ToString() }
        if ($publicIp -notin $resolvedAddresses) {
            throw "$publicHost currently resolves to $($resolvedAddresses -join ', '), not $publicIp."
        }
    }
    catch {
        throw "The direct public hostname is not safely resolving to this home's detected IP. $($_.Exception.Message)"
    }
}

$oldPublicUrl = Get-BabcordSetting -Settings $context.Settings -Name 'BABCORD_PUBLIC_URL' -Default ''
$oldDownloadUrl = Get-BabcordSetting -Settings $context.Settings -Name 'BABCORD_CLIENT_DOWNLOAD_URL' -Default ''
$configurationChanged = -not $oldPublicUrl.Equals($publicOrigin, [StringComparison]::OrdinalIgnoreCase)
Set-BabcordEnvValue -Path $context.ConfigFile -Name 'BABCORD_PUBLIC_URL' -Value $publicOrigin
Set-BabcordEnvValue -Path $context.ConfigFile -Name 'BABCORD_WEB_ORIGIN' -Value $publicOrigin
if (-not [string]::IsNullOrWhiteSpace($owner) -and -not [string]::IsNullOrWhiteSpace($repository)) {
    $launcherUrl = ConvertTo-BabcordGitHubRawUrl -Owner $owner -Repository $repository -Branch $branch -Path "$releasesPath/Open Babcord.html"
    Set-BabcordEnvValue -Path $context.ConfigFile -Name 'BABCORD_CLIENT_DOWNLOAD_URL' -Value $launcherUrl
    if (-not $oldDownloadUrl.Equals($launcherUrl, [StringComparison]::OrdinalIgnoreCase)) { $configurationChanged = $true }
}

if ($configurationChanged -and (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2)) {
    Write-Host "Public endpoint changed from $oldPublicUrl to $publicOrigin; safely restarting Babcord."
    & (Join-Path $PSScriptRoot 'Stop-Babcord.ps1') -ConfigFile $context.ConfigFile -KeepTunnel -Confirm:$false
}
& (Join-Path $PSScriptRoot 'Start-Babcord.ps1') -ConfigFile $context.ConfigFile -SkipTunnel

$caddyPath = Get-BabcordCaddyPath -Settings $settings
$caddyfile = Write-BabcordDirectCaddyfile -Settings $settings -HostName $publicHost -BackendPort $context.Port
& $caddyPath validate --config $caddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy rejected the generated direct-host configuration.' }

$caddyProcess = Get-BabcordTrackedCaddyProcess -Settings $settings
if ($null -ne $caddyProcess) {
    & $caddyPath reload --config $caddyfile --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw 'Caddy could not reload the updated direct-host configuration.' }
    Write-Host "Caddy reloaded for $publicOrigin." -ForegroundColor Green
}
else {
    $stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings
    New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    $stdout = Join-Path $stateDirectory 'caddy-stdout.log'
    $stderr = Join-Path $stateDirectory 'caddy-stderr.log'
    $previousDataHome = $env:XDG_DATA_HOME
    $env:XDG_DATA_HOME = Join-Path $stateDirectory 'caddy-data'
    try {
        $caddyArguments = @('run', "--config=`"$caddyfile`"", '--adapter', 'caddyfile')
        $caddyProcess = Start-Process -FilePath $caddyPath -ArgumentList $caddyArguments `
            -WorkingDirectory $stateDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -WindowStyle Hidden -PassThru
    }
    finally {
        if ($null -eq $previousDataHome) { Remove-Item Env:XDG_DATA_HOME -ErrorAction SilentlyContinue }
        else { $env:XDG_DATA_HOME = $previousDataHome }
    }
    Start-Sleep -Seconds 1
    if ($caddyProcess.HasExited) { throw "Caddy exited during startup. Check $stderr." }
    Write-BabcordCaddyPidRecord -Settings $settings -Process $caddyProcess -CaddyPath $caddyPath
    Write-Host "Caddy started for $publicOrigin (PID $($caddyProcess.Id))." -ForegroundColor Green
}

$listeners = @(Get-BabcordTcpListeners -Port 443)
if ($listeners.Count -eq 0) { throw 'Caddy did not create an HTTPS listener on TCP 443.' }
$backendUnsafe = @(Get-BabcordTcpListeners -Port $context.Port | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
if ($backendUnsafe.Count -gt 0) { throw 'Babcord is listening beyond loopback; direct hosting was stopped before publishing a client.' }

$build = $null
if ([string]::IsNullOrWhiteSpace($owner) -or [string]::IsNullOrWhiteSpace($repository)) {
    Write-Warning 'GitHub owner/repository are not configured. The server is starting, but no remote client update can be built or published.'
}
else {
    $build = & (Join-Path $PSScriptRoot 'Build-BabcordDirectClient.ps1') -PublicOrigin $publicOrigin -HomeIPv4 $publicIp -DirectConfigFile $directRecord.Path
}

# Resolve the public hostname to loopback for this one local test. This verifies
# the real public certificate, SNI, HTTPS proxy, and health response without
# depending on whether the home router supports NAT hairpinning.
$publicReady = $false
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($null -ne $curl) {
    $deadline = (Get-Date).AddSeconds($PublicStartupTimeoutSeconds)
    do {
        & $curl.Source --silent --show-error --fail --max-time 8 --resolve "${publicHost}:443:127.0.0.1" "$publicOrigin/health" | Out-Null
        if ($LASTEXITCODE -eq 0) { $publicReady = $true; break }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
}
else {
    Write-Warning 'curl.exe was not found, so the locally resolved public-certificate test could not run.'
}

if (-not $publicReady) {
    Write-Warning 'Public HTTPS is not ready, so the GitHub descriptor was NOT changed. Confirm public IPv4 (no CGNAT), router TCP 80/443 forwarding, Windows firewall, and Caddy logs. This safety gate keeps existing clients on the last working endpoint.'
}
elseif ($null -ne $build -and -not $SkipPublish) {
    if (Test-Path -LiteralPath $configuredTokenFile -PathType Leaf) {
        & (Join-Path $PSScriptRoot 'Publish-BabcordClientToGitHub.ps1') -DirectConfigFile $directRecord.Path `
            -ClientFile $build.ClientFile -DescriptorFile $build.DescriptorFile
    }
    else {
        Write-Warning 'Client artifacts are ready but were not published because the protected GitHub token file is missing. Run Set-BabcordGitHubToken.ps1.'
    }
}

$stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings
[pscustomobject]@{
    publicIPv4 = $publicIp
    publicOrigin = $publicOrigin
    publicTlsReady = $publicReady
    updatedAtUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDirectory 'direct-state.json') -Encoding UTF8

if (-not $publicReady) {
    throw 'Babcord is only running locally because the trusted public HTTPS route did not become ready. The existing GitHub descriptor was preserved. Fix public IPv4/CGNAT, router TCP 80/443 forwarding, firewall, or Caddy certificate errors, then run Start Babcord Direct.bat again.'
}

if (-not $SkipWatcher) {
    & (Join-Path $PSScriptRoot 'Start-BabcordDirectWatcher.ps1') -ConfigFile $context.ConfigFile -DirectConfigFile $directRecord.Path
}

Write-Host ''
Write-Host "Babcord direct endpoint: $publicOrigin" -ForegroundColor Green
Write-Host "Detected home IPv4 embedded in the complete client: $publicIp"
Write-Host 'External TCP 80 and 443 must remain forwarded to this computer. TCP 8080 must never be forwarded.'
