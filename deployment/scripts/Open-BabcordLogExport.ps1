[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [string]$OutputFile
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$resolvedInput = Resolve-BabcordFullPath -Path $InputFile -Label 'InputFile'
if (-not (Test-Path -LiteralPath $resolvedInput -PathType Leaf)) {
    throw "Babcord log archive not found: $resolvedInput"
}
if ([System.IO.Path]::GetExtension($resolvedInput) -ine '.bclog') {
    throw 'InputFile must be a .bclog archive.'
}

if ([string]::IsNullOrWhiteSpace($OutputFile)) {
    $inputDirectory = Split-Path -Parent $resolvedInput
    $inputName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedInput)
    $OutputFile = Join-Path $inputDirectory "$inputName.decrypted.json"
}
$resolvedOutput = Resolve-BabcordFullPath -Path $OutputFile -Label 'OutputFile'
if (Test-Path -LiteralPath $resolvedOutput) {
    throw "Output already exists and will not be overwritten: $resolvedOutput"
}

$nodePath = Get-BabcordNodePath
$helper = Join-Path $script:BabcordDeploymentRoot 'helpers\decrypt-bclog.mjs'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "The Babcord archive helper is missing: $helper"
}

$securePassword = Read-Host 'Babcord password used when this archive was created' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    $encodedPassword = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plainPassword))
    $result = $encodedPassword | & $nodePath $helper $resolvedInput $resolvedOutput
    if ($LASTEXITCODE -ne 0) {
        throw 'The archive could not be opened. The password may be incorrect or the file may be damaged.'
    }
}
finally {
    $plainPassword = $null
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

$details = $result | ConvertFrom-Json
Write-Host "Decrypted $($details.records) audit records to:" -ForegroundColor Green
Write-Host $details.outputPath
Write-Warning 'The JSON contains sensitive audit data. Review it locally, protect it, and remove it securely when no longer needed.'

