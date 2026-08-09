[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$DirectConfigFile,
    [switch]$Remove
)

. (Join-Path $PSScriptRoot 'Direct-Common.ps1')

if ([string]::IsNullOrWhiteSpace($DirectConfigFile)) { $DirectConfigFile = Get-BabcordDirectConfigPath }
$settings = (Get-BabcordDirectSettings -DirectConfigFile $DirectConfigFile).Values
$defaultTokenFile = Join-Path $env:ProgramData 'Babcord\config\github-token.txt'
$tokenFile = Resolve-BabcordFullPath -Path (Get-BabcordSetting -Settings $settings -Name 'BABCORD_GITHUB_TOKEN_FILE' -Default $defaultTokenFile) -Label 'GitHub token file'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tokenFile) | Out-Null

if ($Remove) {
    if ((Test-Path -LiteralPath $tokenFile -PathType Leaf) -and $PSCmdlet.ShouldProcess($tokenFile, 'Permanently remove the stored GitHub token')) {
        Remove-Item -LiteralPath $tokenFile -Force
        Write-Host 'The stored GitHub token was removed. Revoke it on GitHub too if it should no longer work.' -ForegroundColor Yellow
    }
    return
}

Write-Host 'Paste a fine-grained GitHub token limited to the chosen repository with Contents: read/write.'
Write-Host 'The token is hidden while typing and is never written to direct.env, command history, or logs.'
$secureToken = Read-Host 'Token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 20 -or $plainToken -match '\s') {
        throw 'The token value did not look valid.'
    }
    [IO.File]::WriteAllText($tokenFile, $plainToken.Trim(), [Text.UTF8Encoding]::new($false))
}
finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plainToken = $null
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $tokenFile '/inheritance:r' '/grant:r' "${currentIdentity}:F" 'SYSTEM:F' 'BUILTIN\Administrators:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows could not apply private permissions to the GitHub token file.' }
Write-Host "GitHub token saved in the protected token file: $tokenFile" -ForegroundColor Green
