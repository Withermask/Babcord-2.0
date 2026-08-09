[CmdletBinding()]
param(
    [string]$ConfigFile
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
if (@(Get-BabcordMaintenanceMarkers -Context $context).Count -gt 0) {
    Write-Error 'Babcord startup was skipped because maintenance is marked in progress.'
    exit 75
}

$nodePath = Get-BabcordNodePath
$entryPath = Resolve-BabcordFullPath -Path (Join-Path $context.RepositoryRoot $context.ServerEntry) -Label 'Server entry'
$null = Assert-BabcordChildPath -Parent $context.RepositoryRoot -Child $entryPath -Label 'Server entry'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Babcord server entry was not found: $entryPath"
}

New-Item -ItemType Directory -Force -Path $context.LogDir, $context.StateDir | Out-Null
$stdout = Join-Path $context.LogDir 'babcord-stdout.log'
$stderr = Join-Path $context.LogDir 'babcord-stderr.log'
foreach ($logPath in @($stdout, $stderr)) {
    if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    }
}

$arguments = @(
    "--env-file=`"$($context.ConfigFile)`""
    "`"$entryPath`""
)
$process = Start-BabcordNodeProcess -NodePath $nodePath -Arguments $arguments -WorkingDirectory $context.RepositoryRoot `
    -StandardOutputPath $stdout -StandardErrorPath $stderr
Write-BabcordPidRecord -Context $context -ProcessId $process.Id -NodePath $nodePath

try {
    $process.WaitForExit()
    exit $process.ExitCode
}
finally {
    $pidFile = Get-BabcordPidFile -Context $context
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        try {
            $record = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
            if ([int]$record.pid -eq $process.Id) {
                Remove-Item -LiteralPath $pidFile -Force
            }
        }
        catch {
            # A malformed/stale PID file is left for explicit operator inspection.
        }
    }
}
