[CmdletBinding()]
param(
    [string]$ConfigFile,
    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
    [string]$DailyBackupTime = '02:00',
    [switch]$ReplaceExisting
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator, then run this script again.'
}
if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$nodePath = Get-BabcordNodePath
$entryPath = Resolve-BabcordFullPath -Path (Join-Path $context.RepositoryRoot $context.ServerEntry) -Label 'Server entry'
$null = Assert-BabcordChildPath -Parent $context.RepositoryRoot -Child $entryPath -Label 'Server entry'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Server entry was not found: $entryPath"
}

$repositoryDrive = [System.IO.Path]::GetPathRoot($context.RepositoryRoot).TrimEnd('\')
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$repositoryDrive'"
if ($null -eq $disk -or [int]$disk.DriveType -ne 3) {
    throw 'The Babcord repository must be on a fixed local disk for the SYSTEM startup task. Mapped/network/removable drives are not supported.'
}

$taskNames = @(
    Get-BabcordAppTaskName
    Get-BabcordMonitorTaskName
    Get-BabcordBackupTaskName
)
$existingTasks = @($taskNames | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } | Where-Object { $null -ne $_ })
if ($existingTasks.Count -gt 0 -and -not $ReplaceExisting) {
    throw 'One or more Babcord tasks already exist. Review them first, then rerun with -ReplaceExisting if replacement is intended.'
}

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellPath)) {
    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
}
$runnerScript = Join-Path $PSScriptRoot 'Run-BabcordTask.ps1'
$appArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$runnerScript`" -ConfigFile `"$($context.ConfigFile)`""
$appAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $appArguments -WorkingDirectory $context.RepositoryRoot
$appTrigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)
$appSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$appTask = New-ScheduledTask -Action $appAction -Trigger $appTrigger -Principal $principal -Settings $appSettings `
    -Description 'Runs the Babcord Node.js application after Windows starts.'

$monitorScript = Join-Path $PSScriptRoot 'Invoke-BabcordMonitor.ps1'
$monitorArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$monitorScript`" -ConfigFile `"$($context.ConfigFile)`" -RestartOnFailure"
$monitorAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $monitorArguments -WorkingDirectory $context.RepositoryRoot
$monitorTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$monitorSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$monitorTask = New-ScheduledTask -Action $monitorAction -Trigger $monitorTrigger -Principal $principal -Settings $monitorSettings `
    -Description 'Checks local/public Babcord health every five minutes and attempts safe service recovery.'

$backupScript = Join-Path $PSScriptRoot 'Backup-Babcord.ps1'
$backupArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$backupScript`" -ConfigFile `"$($context.ConfigFile)`""
$backupAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $backupArguments -WorkingDirectory $context.RepositoryRoot
$backupAt = [DateTime]::Today.Add([TimeSpan]::Parse($DailyBackupTime))
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $backupAt
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$backupTask = New-ScheduledTask -Action $backupAction -Trigger $backupTrigger -Principal $principal -Settings $backupSettings `
    -Description 'Creates and verifies a daily Babcord SQLite/data snapshot, then prunes expired routine backups.'

Register-ScheduledTask -TaskName (Get-BabcordAppTaskName) -InputObject $appTask -Force | Out-Null
Register-ScheduledTask -TaskName (Get-BabcordMonitorTaskName) -InputObject $monitorTask -Force | Out-Null
Register-ScheduledTask -TaskName (Get-BabcordBackupTaskName) -InputObject $backupTask -Force | Out-Null

Write-Host 'Registered Babcord startup, five-minute health monitoring, and daily backup tasks.' -ForegroundColor Green
Write-Host "Daily backup time: $DailyBackupTime"
Write-Host 'Run Start-Babcord.ps1 to start the application now.'
