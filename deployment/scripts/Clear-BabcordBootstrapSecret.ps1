[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$ConfigFile
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$resolvedConfig = Resolve-BabcordFullPath -Path $ConfigFile -Label 'ConfigFile'
$settings = Read-BabcordEnvFile -Path $resolvedConfig

if (-not $settings.Contains('BABCORD_ADMIN_PASSWORD')) {
    Write-Host 'No bootstrap password is present.'
    exit 0
}

if ($PSCmdlet.ShouldProcess($resolvedConfig, 'Remove the bootstrap administrator password after verified first login')) {
    $updated = Get-Content -LiteralPath $resolvedConfig | Where-Object {
        $_ -notmatch '^BABCORD_ADMIN_(USERNAME|PASSWORD)='
    }
    $temporary = "$resolvedConfig.new"
    $updated | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $resolvedConfig -Force
    Write-Host 'The bootstrap username and password were removed. Restart Babcord to reload configuration.' -ForegroundColor Green
}
