[CmdletBinding()]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = Get-BabcordDefaultConfigPath }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$context = Get-BabcordContext -ConfigFile $ConfigFile
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings
$stateFile = Join-Path $stateDirectory 'direct-state.json'
$state = if (Test-Path -LiteralPath $stateFile -PathType Leaf) { Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } else { $null }
$localHealthy = Test-BabcordHealth -Url $context.LocalHealthUrl
$caddy = Get-BabcordTrackedCaddyProcess -Settings $settings
$httpListeners = @(Get-BabcordTcpListeners -Port 80)
$httpsListeners = @(Get-BabcordTcpListeners -Port 443)
$backendListeners = @(Get-BabcordTcpListeners -Port $context.Port)
$unsafeBackend = @($backendListeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
$publicReady = $false
if ($null -ne $state) {
    $hostName = ([Uri][string]$state.publicOrigin).Host
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -ne $curl) {
        & $curl.Source --silent --fail --max-time 8 --resolve "${hostName}:443:127.0.0.1" "$([string]$state.publicOrigin)/health" | Out-Null
        $publicReady = $LASTEXITCODE -eq 0
    }
}
$tokenPath = Resolve-BabcordFullPath -Path (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_TOKEN_FILE' -Default (Join-Path $env:ProgramData 'Babcord\config\github-token.txt')) -Label 'GitHub token file'
$firewall443 = Get-NetFirewallRule -Name 'Babcord-Direct-HTTPS-443' -ErrorAction SilentlyContinue
$firewall80 = Get-NetFirewallRule -Name 'Babcord-Direct-HTTP-Challenge-80' -ErrorAction SilentlyContinue

$rows = @(
    [pscustomobject]@{ Check = 'Babcord backend'; Status = if ($localHealthy) { 'Healthy' } else { 'Offline' }; Detail = $context.LocalHealthUrl }
    [pscustomobject]@{ Check = 'Backend binding'; Status = if ($unsafeBackend.Count -gt 0) { 'UNSAFE' } elseif ($backendListeners.Count -gt 0) { 'Loopback only' } else { 'No listener' }; Detail = (($backendListeners.LocalAddress | Sort-Object -Unique) -join ', ') }
    [pscustomobject]@{ Check = 'Caddy'; Status = if ($null -eq $caddy) { 'Stopped' } else { "PID $($caddy.Id)" }; Detail = 'HTTPS reverse proxy' }
    [pscustomobject]@{ Check = 'TCP 80 listener'; Status = if ($httpListeners.Count -gt 0) { 'Listening' } else { 'Missing' }; Detail = 'Redirect + certificate challenge' }
    [pscustomobject]@{ Check = 'TCP 443 listener'; Status = if ($httpsListeners.Count -gt 0) { 'Listening' } else { 'Missing' }; Detail = 'HTTPS/WSS' }
    [pscustomobject]@{ Check = 'Public TLS route'; Status = if ($publicReady) { 'Healthy locally' } else { 'Not verified' }; Detail = if ($null -eq $state) { 'No saved endpoint' } else { [string]$state.publicOrigin } }
    [pscustomobject]@{ Check = 'Firewall 80/443'; Status = if ($null -ne $firewall80 -and $null -ne $firewall443) { 'Installed' } else { 'Incomplete' }; Detail = 'Exact Caddy executable only' }
    [pscustomobject]@{ Check = 'GitHub token'; Status = if (Test-Path -LiteralPath $tokenPath -PathType Leaf) { 'Stored privately' } else { 'Not configured' }; Detail = $tokenPath }
)
$rows | Format-Table -AutoSize

Write-Host 'A local TLS check cannot prove router forwarding. Test the saved endpoint from cellular data or another outside network.'
if (-not $localHealthy -or $null -eq $caddy -or $httpsListeners.Count -eq 0 -or $unsafeBackend.Count -gt 0) { exit 1 }

