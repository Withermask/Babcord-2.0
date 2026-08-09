[CmdletBinding()]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = Get-BabcordDefaultConfigPath }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$stateDirectory = Get-BabcordDirectStateDirectory -Settings $settings
$pidFile = Join-Path $stateDirectory 'direct-watcher.pid.json'
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    try {
        $record = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
        $existing = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        $recordedStart = [DateTime]::Parse([string]$record.startedAtUtc).ToUniversalTime()
        $recordedExecutable = Resolve-BabcordFullPath -Path ([string]$record.executable) -Label 'Recorded watcher executable'
        $actualExecutable = Resolve-BabcordFullPath -Path $existing.Path -Label 'Watcher executable'
        if ($existing.ProcessName -in @('powershell', 'pwsh') -and
            [Math]::Abs(($recordedStart - $existing.StartTime.ToUniversalTime()).TotalMinutes) -le 2 -and
            $recordedExecutable.Equals($actualExecutable, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    catch { }
}

$powerShell = (Get-Process -Id $PID).Path
$watcherScript = Join-Path $PSScriptRoot 'Watch-BabcordDirect.ps1'
$stdout = Join-Path $stateDirectory 'direct-watcher.log'
$stderr = Join-Path $stateDirectory 'direct-watcher-error.log'
foreach ($logFile in @($stdout, $stderr)) {
    if ((Test-Path -LiteralPath $logFile -PathType Leaf) -and (Get-Item -LiteralPath $logFile).Length -gt 10MB) {
        Move-Item -LiteralPath $logFile -Destination "$logFile.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    }
}
$arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$watcherScript`"",
    '-ConfigFile', "`"$ConfigFile`"",
    '-DirectConfigFile', "`"$DirectConfigFile`""
)
$process = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory (Get-BabcordRepositoryRoot) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
[pscustomobject]@{
    pid = $process.Id
    startedAtUtc = $process.StartTime.ToUniversalTime().ToString('o')
    executable = $powerShell
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Host "Direct-IP watcher started (PID $($process.Id)); it checks every five minutes." -ForegroundColor Green
