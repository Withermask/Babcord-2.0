Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common.ps1')

function Get-BabcordDirectConfigPath {
    if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        throw 'The ProgramData environment variable is unavailable.'
    }
    return Join-Path $env:ProgramData 'Babcord\config\direct.env'
}

function Get-BabcordDirectSettings {
    param([string]$DirectConfigFile = (Get-BabcordDirectConfigPath))

    $resolved = Resolve-BabcordFullPath -Path $DirectConfigFile -Label 'Direct-host configuration file'
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Direct-host configuration was not found at $resolved. Run Initialize-BabcordDirectHost.ps1 first."
    }
    return [pscustomobject]@{
        Path = $resolved
        Values = Read-BabcordEnvFile -Path $resolved
    }
}

function Set-BabcordEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )

    if ($Value -match '[\r\n]') {
        throw "$Name cannot contain a line break."
    }
    $resolved = Resolve-BabcordFullPath -Path $Path -Label 'Environment file'
    $lines = if (Test-Path -LiteralPath $resolved -PathType Leaf) { @(Get-Content -LiteralPath $resolved) } else { @() }
    $replacement = "$Name=$Value"
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $lines[$index] = $replacement
            $found = $true
        }
    }
    if (-not $found) {
        $lines += $replacement
    }
    $temporary = "$resolved.new"
    $lines | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $resolved -Force
}

function Test-BabcordPublicIPv4 {
    param([Parameter(Mandatory = $true)][string]$Address)

    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Address.Trim(), [ref]$parsed) -or
        $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }
    $bytes = $parsed.GetAddressBytes()
    $a = [int]$bytes[0]
    $b = [int]$bytes[1]
    if ($a -eq 0 -or $a -eq 10 -or $a -eq 127 -or $a -ge 224) { return $false }
    if ($a -eq 100 -and $b -ge 64 -and $b -le 127) { return $false } # carrier-grade NAT
    if ($a -eq 169 -and $b -eq 254) { return $false }
    if ($a -eq 172 -and $b -ge 16 -and $b -le 31) { return $false }
    if ($a -eq 192 -and $b -eq 0 -and [int]$bytes[2] -eq 0) { return $false }
    if ($a -eq 192 -and $b -eq 168) { return $false }
    if ($a -eq 198 -and $b -in @(18, 19)) { return $false }
    if ($a -eq 198 -and $b -eq 51 -and [int]$bytes[2] -eq 100) { return $false }
    if ($a -eq 203 -and $b -eq 0 -and [int]$bytes[2] -eq 113) { return $false }
    return $true
}

function Get-BabcordPublicIPv4 {
    [CmdletBinding()]
    param()

    # Two independent services must agree. A single compromised or stale service
    # is not allowed to redirect every generated client to an arbitrary host.
    $services = @(
        'https://api4.ipify.org',
        'https://checkip.amazonaws.com',
        'https://ipv4.icanhazip.com'
    )
    $answers = @()
    foreach ($service in $services) {
        try {
            $answer = ([string](Invoke-RestMethod -Uri $service -TimeoutSec 8 -Headers @{
                'User-Agent' = 'Babcord-Direct-Host/1.0'
                'Cache-Control' = 'no-cache'
            })).Trim()
            if (Test-BabcordPublicIPv4 -Address $answer) {
                $answers += $answer
            }
        }
        catch {
            Write-Verbose "Public IP service failed: $service"
        }
    }
    $winner = $answers | Group-Object | Sort-Object Count -Descending | Select-Object -First 1
    if ($null -eq $winner -or $winner.Count -lt 2) {
        $safeSummary = if ($answers.Count -eq 0) { 'no valid public IPv4 answers' } else { ($answers -join ', ') }
        throw "Could not safely determine the public IPv4 address because two independent HTTPS services did not agree ($safeSummary)."
    }
    return [string]$winner.Name
}

function Get-BabcordDirectPublicHost {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory = $true)][string]$PublicIPv4
    )

    $override = Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_PUBLIC_HOST' -Default ''
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        $hostName = $override.Trim().ToLowerInvariant()
    }
    else {
        $prefix = (Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_HOST_PREFIX' -Default 'babcord').Trim().ToLowerInvariant()
        $suffix = (Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_DNS_SUFFIX' -Default 'sslip.io').Trim().Trim('.').ToLowerInvariant()
        if ($prefix -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
            throw 'BABCORD_DIRECT_HOST_PREFIX must be one DNS label containing only letters, numbers, and hyphens.'
        }
        if ($suffix -notmatch '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' -or $suffix.Contains('..')) {
            throw 'BABCORD_DIRECT_DNS_SUFFIX is not a valid DNS suffix.'
        }
        $hostName = "$prefix-$($PublicIPv4.Replace('.', '-')).$suffix"
    }

    $isIp = $null
    $hostIsIpAddress = [Net.IPAddress]::TryParse($hostName, [ref]$isIp)
    if ($hostIsIpAddress -and -not $hostName.Equals($PublicIPv4, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A raw BABCORD_DIRECT_PUBLIC_HOST must exactly match the currently detected public IPv4 address.'
    }
    if (-not $hostIsIpAddress -and ($hostName -notmatch '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' -or $hostName.Contains('..'))) {
        throw 'BABCORD_DIRECT_PUBLIC_HOST is not a valid hostname or IP address.'
    }
    return $hostName
}

function Get-BabcordCaddyPath {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings)

    $configured = Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_CADDY_PATH' -Default ''
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($configured)) { $candidates += $configured }
    $command = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { $candidates += $command.Source }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) { $candidates += (Join-Path $env:ProgramFiles 'Caddy\caddy.exe') }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\caddy.exe') }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramData)) { $candidates += (Join-Path $env:ProgramData 'Babcord\direct\caddy.exe') }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        try {
            $resolved = Resolve-BabcordFullPath -Path $candidate -Label 'Caddy executable'
            if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
        }
        catch { }
    }
    throw 'Caddy was not found. Run Initialize-BabcordDirectHost.ps1 -InstallCaddy or set BABCORD_DIRECT_CADDY_PATH.'
}

function Get-BabcordDirectStateDirectory {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings)
    $default = Join-Path $env:ProgramData 'Babcord\direct'
    return Assert-BabcordManagedPath -Path (Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_STATE_DIR' -Default $default) -Label 'BABCORD_DIRECT_STATE_DIR'
}

function Get-BabcordDirectOutputDirectory {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings)
    $default = Join-Path (Get-BabcordDirectStateDirectory -Settings $Settings) 'release'
    return Assert-BabcordManagedPath -Path (Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_OUTPUT_DIR' -Default $default) -Label 'BABCORD_DIRECT_OUTPUT_DIR'
}

function Write-BabcordDirectCaddyfile {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$BackendPort
    )

    $stateDirectory = Get-BabcordDirectStateDirectory -Settings $Settings
    New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
    $caddyfile = Join-Path $stateDirectory 'Caddyfile'
    $logPath = (Join-Path $stateDirectory 'caddy-access.log').Replace('\', '/')
    $cert = Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_TLS_CERT_FILE' -Default ''
    $key = Get-BabcordSetting -Settings $Settings -Name 'BABCORD_DIRECT_TLS_KEY_FILE' -Default ''
    if ([string]::IsNullOrWhiteSpace($cert) -xor [string]::IsNullOrWhiteSpace($key)) {
        throw 'BABCORD_DIRECT_TLS_CERT_FILE and BABCORD_DIRECT_TLS_KEY_FILE must be supplied together.'
    }
    $tlsLine = ''
    if (-not [string]::IsNullOrWhiteSpace($cert)) {
        $certPath = Resolve-BabcordFullPath -Path $cert -Label 'TLS certificate file'
        $keyPath = Resolve-BabcordFullPath -Path $key -Label 'TLS private key file'
        if (-not (Test-Path -LiteralPath $certPath -PathType Leaf) -or -not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
            throw 'The configured TLS certificate or private key file does not exist.'
        }
        $tlsLine = "    tls `"$($certPath.Replace('\', '/'))`" `"$($keyPath.Replace('\', '/'))`""
    }
    else {
        $parsedIp = $null
        if ([Net.IPAddress]::TryParse($HostName, [ref]$parsedIp)) {
            throw 'A raw IP public host requires a publicly trusted certificate and key override. The default sslip.io hostname is recommended.'
        }
    }

    $content = @(
        '{'
        '    admin 127.0.0.1:2019'
        '}'
        ''
        "$HostName {"
        $tlsLine
        '    encode zstd gzip'
        "    reverse_proxy 127.0.0.1:$BackendPort"
        '    header {'
        '        X-Content-Type-Options nosniff'
        '        Referrer-Policy no-referrer'
        '        Permissions-Policy "camera=(), geolocation=(), microphone=()"'
        '        Strict-Transport-Security "max-age=31536000"'
        '        -Server'
        '    }'
        '    log {'
        "        output file `"$logPath`" {"
        '            roll_size 10MiB'
        '            roll_keep 5'
        '            roll_keep_for 168h'
        '        }'
        '    }'
        '}'
    ) | Where-Object { $null -ne $_ }
    $temporary = "$caddyfile.new"
    $content | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $caddyfile -Force
    return $caddyfile
}

function Get-BabcordCaddyPidFile {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings)
    return Join-Path (Get-BabcordDirectStateDirectory -Settings $Settings) 'caddy.pid.json'
}

function Get-BabcordTrackedCaddyProcess {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings)

    $pidFile = Get-BabcordCaddyPidFile -Settings $Settings
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        if ($process.ProcessName -ne 'caddy') { throw 'Tracked PID is not Caddy.' }
        $recordedStart = [DateTime]::Parse([string]$record.startedAtUtc).ToUniversalTime()
        if ([Math]::Abs(($recordedStart - $process.StartTime.ToUniversalTime()).TotalMinutes) -gt 2) {
            throw 'Tracked Caddy PID was reused.'
        }
        try {
            $actualExecutable = Resolve-BabcordFullPath -Path $process.Path -Label 'Tracked Caddy executable'
            $recordedExecutable = Resolve-BabcordFullPath -Path ([string]$record.executable) -Label 'Recorded Caddy executable'
            if (-not $actualExecutable.Equals($recordedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Tracked Caddy PID uses a different executable.'
            }
        }
        catch [System.ComponentModel.Win32Exception] { }
        return $process
    }
    catch {
        return $null
    }
}

function Write-BabcordCaddyPidRecord {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$CaddyPath
    )
    $pidFile = Get-BabcordCaddyPidFile -Settings $Settings
    [pscustomobject]@{
        pid = $Process.Id
        startedAtUtc = $Process.StartTime.ToUniversalTime().ToString('o')
        executable = $CaddyPath
    } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
}

function ConvertTo-BabcordGitHubRawUrl {
    param(
        [Parameter(Mandatory = $true)][string]$Owner,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $segments = $Path.Replace('\', '/').Split('/') | Where-Object { $_.Length -gt 0 } | ForEach-Object { [Uri]::EscapeDataString($_) }
    $encodedPath = $segments -join '/'
    return "https://raw.githubusercontent.com/$([Uri]::EscapeDataString($Owner))/$([Uri]::EscapeDataString($Repository))/$([Uri]::EscapeDataString($Branch))/$encodedPath"
}
