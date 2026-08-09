[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$ConfigFile,
    [switch]$ApplyBlockRule,
    [switch]$RemoveBlockRule
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ($ApplyBlockRule -and $RemoveBlockRule) {
    throw 'Choose either -ApplyBlockRule or -RemoveBlockRule, not both.'
}
if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$ruleName = "Babcord-Block-Direct-TCP-$($context.Port)"
$existingRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue

if (-not $ApplyBlockRule -and -not $RemoveBlockRule) {
    $listeners = @(Get-BabcordTcpListeners -Port $context.Port)
    $unsafe = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
    Write-Host "Babcord configured binding: $($context.HostAddress):$($context.Port)"
    Write-Host "Defense-in-depth block rule: $(if ($null -eq $existingRule) { 'not installed' } else { $existingRule.Enabled })"
    if ($unsafe.Count -gt 0) {
        Write-Host 'UNSAFE: Babcord is listening beyond loopback.' -ForegroundColor Red
        $unsafe | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
        exit 1
    }
    Write-Host 'No non-loopback Babcord listener was found.' -ForegroundColor Green
    exit 0
}

if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator before changing firewall rules.'
}

if ($ApplyBlockRule) {
    if ($null -ne $existingRule) {
        Write-Host "Firewall rule already exists: $ruleName"
        exit 0
    }
    if ($PSCmdlet.ShouldProcess("TCP port $($context.Port)", 'Create inbound block rule for every Windows Firewall profile')) {
        New-NetFirewallRule -Name $ruleName -DisplayName "Babcord: block direct TCP $($context.Port)" `
            -Description 'Defense in depth: Babcord must be reached only through a same-computer loopback connector such as Caddy or cloudflared.' `
            -Direction Inbound -Action Block -Enabled True -Profile Any -Protocol TCP -LocalPort $context.Port `
            -RemoteAddress @('LocalSubnet', 'Internet') | Out-Null
        Write-Host "Created firewall rule: $ruleName" -ForegroundColor Green
    }
}

if ($RemoveBlockRule) {
    if ($null -eq $existingRule) {
        Write-Host "Firewall rule is not installed: $ruleName"
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($ruleName, 'Remove only the Babcord-managed firewall rule')) {
        Remove-NetFirewallRule -Name $ruleName
        Write-Host "Removed firewall rule: $ruleName" -ForegroundColor Yellow
    }
}
