[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigFile,
    [switch]$KeepTunnel
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$stoppedSomething = $false
$taskName = Get-BabcordAppTaskName
$appTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $appTask -and $appTask.State -eq 'Running') {
    if ($PSCmdlet.ShouldProcess($taskName, 'Stop Babcord application task')) {
        Stop-ScheduledTask -TaskName $taskName
        $stoppedSomething = $true
        Write-Host 'Babcord application task stopped.'
    }
}

$process = Get-BabcordTrackedProcess -Context $context
if ($null -ne $process) {
    if ($PSCmdlet.ShouldProcess("PID $($process.ProcessId)", 'Stop verified Babcord Node.js process')) {
        Stop-Process -Id $process.ProcessId
        try {
            Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction Stop
        }
        catch {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        $stoppedSomething = $true
        Write-Host 'Babcord process stopped.'
    }
}

$pidFile = Get-BabcordPidFile -Context $context
if (-not (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $KeepTunnel) {
    $tunnel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    if ($null -ne $tunnel -and $tunnel.Status -ne 'Stopped') {
        if ($PSCmdlet.ShouldProcess('cloudflared', 'Stop Babcord public tunnel')) {
            try {
                Stop-Service -Name 'cloudflared'
                Write-Host 'Cloudflare Tunnel stopped.'
                $stoppedSomething = $true
            }
            catch {
                Write-Warning "Cloudflare Tunnel could not be stopped: $($_.Exception.Message)"
            }
        }
    }
}

$shutdownDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $shutdownDeadline -and (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 1)) {
    Start-Sleep -Milliseconds 500
}
if (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 1) {
    throw 'Babcord still answers health checks after the stop request. It was not safe to continue maintenance.'
}

if (-not $stoppedSomething) {
    Write-Host 'Babcord was not running.'
}
