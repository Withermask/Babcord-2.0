[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$DirectConfigFile,
    [switch]$ApplyRules,
    [switch]$RemoveRules
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ($ApplyRules -and $RemoveRules) { throw 'Choose either -ApplyRules or -RemoveRules, not both.' }
if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$caddyPath = Get-BabcordCaddyPath -Settings $settings
$ruleNames = @('Babcord-Direct-HTTPS-443', 'Babcord-Direct-HTTP-Challenge-80')

if (-not $ApplyRules -and -not $RemoveRules) {
    $rows = @(foreach ($name in $ruleNames) {
        $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
        [pscustomobject]@{
            Rule = $name
            Status = if ($null -eq $rule) { 'Not installed' } else { [string]$rule.Enabled }
            Program = $caddyPath
        }
    })
    $rows | Format-Table -AutoSize
    exit 0
}
if (-not (Test-BabcordAdministrator)) {
    throw 'Open PowerShell as Administrator before changing firewall rules.'
}

if ($ApplyRules) {
    $definitions = @(
        @{ Name = $ruleNames[0]; Port = 443; Description = 'Babcord direct HTTPS through the exact Caddy executable.' },
        @{ Name = $ruleNames[1]; Port = 80; Description = 'Babcord HTTP-to-HTTPS redirect and ACME HTTP-01 challenge through the exact Caddy executable.' }
    )
    foreach ($definition in $definitions) {
        $existing = Get-NetFirewallRule -Name $definition.Name -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            $programFilter = $existing | Get-NetFirewallApplicationFilter
            $portFilter = $existing | Get-NetFirewallPortFilter
            if (-not ([string]$programFilter.Program).Equals($caddyPath, [StringComparison]::OrdinalIgnoreCase) -or
                [string]$portFilter.LocalPort -ne [string]$definition.Port) {
                throw "Existing firewall rule $($definition.Name) does not match the expected executable/port. Inspect it manually; setup will not replace an unexpected rule."
            }
            Write-Host "Firewall rule already exists: $($definition.Name)"
            continue
        }
        if ($PSCmdlet.ShouldProcess("$caddyPath TCP $($definition.Port)", 'Allow inbound public traffic')) {
            New-NetFirewallRule -Name $definition.Name -DisplayName "Babcord Direct: Caddy TCP $($definition.Port)" `
                -Description $definition.Description -Direction Inbound -Action Allow -Enabled True -Profile Any `
                -Protocol TCP -LocalPort $definition.Port -Program $caddyPath | Out-Null
            Write-Host "Created firewall rule: $($definition.Name)" -ForegroundColor Green
        }
    }
}

if ($RemoveRules) {
    foreach ($name in $ruleNames) {
        $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
        if ($null -ne $existing -and $PSCmdlet.ShouldProcess($name, 'Remove only this Babcord-managed firewall rule')) {
            Remove-NetFirewallRule -Name $name
            Write-Host "Removed firewall rule: $name" -ForegroundColor Yellow
        }
    }
}
