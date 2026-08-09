[CmdletBinding()]
param(
    [string]$ConfigFile,
    [string]$DirectConfigFile,
    [int]$IntervalSeconds = 300
)

$ErrorActionPreference = 'Continue'
if ($IntervalSeconds -lt 60) { throw 'IntervalSeconds must be at least 60.' }
while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    try {
        & (Join-Path $PSScriptRoot 'Start-BabcordDirect.ps1') -ConfigFile $ConfigFile -DirectConfigFile $DirectConfigFile -SkipWatcher
    }
    catch {
        Write-Output "[$([DateTime]::UtcNow.ToString('o'))] Direct-host refresh failed: $($_.Exception.Message)"
    }
}

