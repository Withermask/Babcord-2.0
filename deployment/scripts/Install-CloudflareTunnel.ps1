[CmdletBinding()]
param(
    [string]$CloudflaredPath
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator, then run this script again.'
}

if (Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue) {
    throw 'The cloudflared Windows service already exists. This script will not replace or reconfigure an existing tunnel.'
}

if ([string]::IsNullOrWhiteSpace($CloudflaredPath)) {
    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw 'cloudflared was not found. Install it from Cloudflare, reopen PowerShell, and rerun this script.'
    }
    $CloudflaredPath = $command.Source
}
$resolvedCloudflared = Resolve-BabcordFullPath -Path $CloudflaredPath -Label 'CloudflaredPath'
if (-not (Test-Path -LiteralPath $resolvedCloudflared -PathType Leaf)) {
    throw "cloudflared executable was not found: $resolvedCloudflared"
}

Write-Host 'In Cloudflare, create a remotely managed tunnel named Babcord-Windows.'
Write-Host 'Add public hostname babcord.withermask.net with service http://127.0.0.1:8080.'
Write-Host 'Copy the Windows connector token, then paste it below. It will not be printed.'
$secureToken = Read-Host 'Tunnel token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$plainToken = $null
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 40 -or $plainToken -match '\s') {
        throw 'The tunnel token does not look valid. Nothing was installed.'
    }

    & $resolvedCloudflared service install $plainToken
    if ($LASTEXITCODE -ne 0) {
        throw "cloudflared service installation failed with exit code $LASTEXITCODE."
    }
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $plainToken = $null
}

$service = Get-Service -Name 'cloudflared' -ErrorAction Stop
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
Write-Host 'Cloudflare Tunnel is installed and running.' -ForegroundColor Green
Write-Host 'The token is stored by the protected Windows service. Do not paste it into configuration files or chat.'

