[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = Get-BabcordDefaultConfigPath }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings

$watcherPidFile = Join-Path $stateDirectory 'direct-watcher.pid.json'
if (Test-Path -LiteralPath $watcherPidFile -PathType Leaf) {
    try {
        $record = Get-Content -Raw -LiteralPath $watcherPidFile | ConvertFrom-Json
        $watcher = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        $recordedStart = [DateTime]::Parse([string]$record.startedAtUtc).ToUniversalTime()
        $recordedExecutable = Resolve-BabcordFullPath -Path ([string]$record.executable) -Label 'Recorded watcher executable'
        $actualExecutable = Resolve-BabcordFullPath -Path $watcher.Path -Label 'Watcher executable'
        if ($watcher.ProcessName -notin @('powershell', 'pwsh') -or
            [Math]::Abs(($recordedStart - $watcher.StartTime.ToUniversalTime()).TotalMinutes) -gt 2 -or
            -not $recordedExecutable.Equals($actualExecutable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Watcher PID no longer belongs to the recorded PowerShell process.'
        }
        if ($PSCmdlet.ShouldProcess("PID $($watcher.Id)", 'Stop verified Babcord direct-IP watcher')) {
            Stop-Process -Id $watcher.Id
            Write-Host 'Direct-IP watcher stopped.'
        }
    }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
    Remove-Item -LiteralPath $watcherPidFile -Force -ErrorAction SilentlyContinue
}

$caddy = Get-BabcordTrackedCaddyProcess -Settings $settings
if ($null -ne $caddy -and $PSCmdlet.ShouldProcess("PID $($caddy.Id)", 'Stop verified Caddy process')) {
    Stop-Process -Id $caddy.Id
    try { Wait-Process -Id $caddy.Id -Timeout 15 -ErrorAction Stop }
    catch { Stop-Process -Id $caddy.Id -Force -ErrorAction SilentlyContinue }
    Write-Host 'Caddy stopped.'
}
Remove-Item -LiteralPath (Get-BabcordCaddyPidFile -Settings $settings) -Force -ErrorAction SilentlyContinue

& (Join-Path $PSScriptRoot 'Stop-Babcord.ps1') -ConfigFile $ConfigFile -KeepTunnel -Confirm:$false
Write-Host 'Babcord direct hosting is stopped.' -ForegroundColor Green
