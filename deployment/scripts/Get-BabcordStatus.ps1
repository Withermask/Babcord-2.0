[CmdletBinding()]
param(
    [string]$ConfigFile,
    [switch]$SkipPublicCheck
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$localHealthy = Test-BabcordHealth -Url $context.LocalHealthUrl
$publicHealthy = $null
if (-not $SkipPublicCheck) {
    $publicHealthy = Test-BabcordHealth -Url ($context.PublicUrl.TrimEnd('/') + '/health') -TimeoutSeconds 8
}

$task = Get-ScheduledTask -TaskName (Get-BabcordAppTaskName) -ErrorAction SilentlyContinue
$tracked = Get-BabcordTrackedProcess -Context $context
$tunnel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
$listeners = @(Get-BabcordTcpListeners -Port $context.Port)
$unsafeListeners = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
$listenerAddresses = @( $listeners | Select-Object -ExpandProperty LocalAddress -ErrorAction SilentlyContinue )
$latestBackup = Get-ChildItem -LiteralPath $context.BackupDir -Directory -Filter 'babcord-backup-*' -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $_.FullName '.incomplete') -PathType Leaf) } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$drive = Get-Item -LiteralPath ([System.IO.Path]::GetPathRoot($context.DataDir))
$freeSpace = $null
try {
    $logicalDisk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($drive.Name.TrimEnd('\'))'"
    $freeSpace = if ($null -ne $logicalDisk) { [math]::Round($logicalDisk.FreeSpace / 1GB, 1) } else { $null }
}
catch {
    try {
        $driveInfo = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($context.DataDir))
        $freeSpace = [math]::Round($driveInfo.AvailableFreeSpace / 1GB, 1)
    }
    catch {
        $freeSpace = $null
    }
}

$rows = @(
    [pscustomobject]@{ Check = 'Local application'; Status = if ($localHealthy) { 'Healthy' } else { 'Offline/unhealthy' }; Detail = $context.LocalHealthUrl }
    [pscustomobject]@{ Check = 'Public domain'; Status = if ($SkipPublicCheck) { 'Not checked' } elseif ($publicHealthy) { 'Healthy' } else { 'Unreachable' }; Detail = $context.PublicUrl }
    [pscustomobject]@{ Check = 'Startup task'; Status = if ($null -eq $task) { 'Not installed' } else { [string]$task.State }; Detail = Get-BabcordAppTaskName }
    [pscustomobject]@{ Check = 'Tracked process'; Status = if ($null -eq $tracked) { 'None' } else { "PID $($tracked.ProcessId)" }; Detail = 'Direct-start tracking' }
    [pscustomobject]@{ Check = 'Cloudflare Tunnel'; Status = if ($null -eq $tunnel) { 'Not installed' } else { [string]$tunnel.Status }; Detail = 'Windows service: cloudflared' }
    [pscustomobject]@{ Check = 'Network binding'; Status = if ($unsafeListeners.Count -gt 0) { 'UNSAFE' } elseif ($listeners.Count -gt 0) { 'Loopback only' } else { 'No listener' }; Detail = (($listenerAddresses | Sort-Object -Unique) -join ', ') }
    [pscustomobject]@{ Check = 'Latest backup'; Status = if ($null -eq $latestBackup) { 'None found' } else { $latestBackup.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }; Detail = if ($null -eq $latestBackup) { $context.BackupDir } else { $latestBackup.FullName } }
    [pscustomobject]@{ Check = 'Data disk free'; Status = if ($null -eq $freeSpace) { 'Unknown' } else { "$freeSpace GB" }; Detail = $drive.Name }
)

$rows | Format-Table -AutoSize

if (-not $localHealthy -or (-not $SkipPublicCheck -and -not $publicHealthy) -or $unsafeListeners.Count -gt 0) {
    exit 1
}
