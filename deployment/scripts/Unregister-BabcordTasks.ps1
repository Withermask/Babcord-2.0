[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator, then run this script again.'
}

$expected = 'REMOVE BABCORD TASKS'
Write-Host "This removes only Babcord's three Windows scheduled tasks. It does not delete application data or backups."
Write-Host "Type exactly: $expected" -ForegroundColor Yellow
$confirmation = Read-Host 'Confirmation'
if ($confirmation -cne $expected) {
    throw 'Confirmation did not match. Nothing was changed.'
}

foreach ($taskName in @(Get-BabcordAppTaskName; Get-BabcordMonitorTaskName; Get-BabcordBackupTaskName)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        continue
    }
    if ($PSCmdlet.ShouldProcess($taskName, 'Unregister Babcord scheduled task')) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task: $taskName"
    }
}

