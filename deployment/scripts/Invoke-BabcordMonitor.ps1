[CmdletBinding()]
param(
    [string]$ConfigFile,
    [switch]$RestartOnFailure
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
New-Item -ItemType Directory -Force -Path $context.LogDir | Out-Null
$monitorLog = Join-Path $context.LogDir 'health-monitor.log'
if ((Test-Path -LiteralPath $monitorLog -PathType Leaf) -and (Get-Item -LiteralPath $monitorLog).Length -gt 5MB) {
    Move-Item -LiteralPath $monitorLog -Destination "$monitorLog.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

function Write-MonitorLine {
    param([string]$Message)
    "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') $Message" | Add-Content -LiteralPath $monitorLog -Encoding UTF8
}

$maintenanceMarkers = @(Get-BabcordMaintenanceMarkers -Context $context)
if ($maintenanceMarkers.Count -gt 0) {
    Write-MonitorLine 'INFO Health/restart checks skipped during declared Babcord maintenance.'
    exit 0
}

$localHealthy = Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 4
if (-not $localHealthy) {
    Start-Sleep -Seconds 2
    $localHealthy = Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 4
}

if (-not $localHealthy) {
    Write-MonitorLine 'ERROR Local health check failed twice.'
    if ($RestartOnFailure) {
        try {
            & (Join-Path $PSScriptRoot 'Start-Babcord.ps1') -ConfigFile $context.ConfigFile -StartupTimeoutSeconds 25
            Write-MonitorLine 'INFO Restart attempt completed.'
        }
        catch {
            Write-MonitorLine "ERROR Restart failed: $($_.Exception.Message)"
            exit 1
        }
    }
    else {
        exit 1
    }
}

$publicHealthUrl = $context.PublicUrl.TrimEnd('/') + '/health'
if (-not (Test-BabcordHealth -Url $publicHealthUrl -TimeoutSeconds 8)) {
    Write-MonitorLine 'WARN Public health check failed while local service is healthy.'
    $tunnel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    if ($RestartOnFailure -and $null -ne $tunnel -and $tunnel.Status -ne 'Running') {
        try {
            Start-Service -Name 'cloudflared'
            Write-MonitorLine 'INFO Cloudflare Tunnel restart requested.'
        }
        catch {
            Write-MonitorLine "ERROR Cloudflare Tunnel restart failed: $($_.Exception.Message)"
            exit 1
        }
    }
}
else {
    Write-MonitorLine 'OK Local and public health checks passed.'
}
