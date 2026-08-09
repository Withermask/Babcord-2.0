[CmdletBinding()]
param(
    [string]$ConfigFile,
    [int]$StartupTimeoutSeconds = 25,
    [switch]$SkipTunnel
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Get-BabcordDefaultConfigPath
}
$context = Get-BabcordContext -ConfigFile $ConfigFile
$maintenanceMarkers = @(Get-BabcordMaintenanceMarkers -Context $context)
if ($maintenanceMarkers.Count -gt 0) {
    $operations = ($maintenanceMarkers.BaseName -replace '\.maintenance$', '') -join ', '
    throw "Babcord maintenance is in progress ($operations). Start was cancelled to protect data."
}
$nodePath = Get-BabcordNodePath
$entryPath = Resolve-BabcordFullPath -Path (Join-Path $context.RepositoryRoot $context.ServerEntry) -Label 'Server entry'
$null = Assert-BabcordChildPath -Parent $context.RepositoryRoot -Child $entryPath -Label 'Server entry'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Babcord server entry was not found: $entryPath"
}

if (Test-BabcordHealth -Url $context.LocalHealthUrl) {
    Write-Host 'Babcord is already online.' -ForegroundColor Green
}
else {
    $appTask = Get-ScheduledTask -TaskName (Get-BabcordAppTaskName) -ErrorAction SilentlyContinue
    if ($null -ne $appTask) {
        if ($appTask.State -eq 'Running') {
            Write-Host 'The startup task is running but unhealthy; restarting that task...'
            & (Join-Path $PSScriptRoot 'Stop-Babcord.ps1') -ConfigFile $context.ConfigFile -KeepTunnel
        }
        Start-ScheduledTask -TaskName (Get-BabcordAppTaskName)
        Write-Host 'Starting Babcord through its Windows startup task...'
    }
    else {
        $existingProcess = Get-BabcordTrackedProcess -Context $context
        if ($null -ne $existingProcess) {
            throw "A tracked Babcord process exists (PID $($existingProcess.ProcessId)) but health checks fail. Stop it before starting another copy."
        }

        $listeners = @(Get-BabcordTcpListeners -Port $context.Port)
        if ($listeners.Count -gt 0) {
            $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
            throw "Port $($context.Port) is already in use by process ID(s) $owners. Babcord was not started."
        }

        New-Item -ItemType Directory -Force -Path $context.LogDir, $context.StateDir | Out-Null
        $stdout = Join-Path $context.LogDir 'babcord-stdout.log'
        $stderr = Join-Path $context.LogDir 'babcord-stderr.log'
        foreach ($logPath in @($stdout, $stderr)) {
            if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
                $rotated = "$logPath.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
                Move-Item -LiteralPath $logPath -Destination $rotated
            }
        }

        $arguments = @(
            "--env-file=`"$($context.ConfigFile)`""
            "`"$entryPath`""
        )
        $process = Start-BabcordNodeProcess -NodePath $nodePath -Arguments $arguments -WorkingDirectory $context.RepositoryRoot `
            -StandardOutputPath $stdout -StandardErrorPath $stderr
        Write-BabcordPidRecord -Context $context -ProcessId $process.Id -NodePath $nodePath
        Write-Host "Starting Babcord (process $($process.Id))..."
    }

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 500
        if (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2) {
            Write-Host "Babcord is healthy at $($context.LocalHealthUrl)." -ForegroundColor Green
            break
        }
    } while ((Get-Date) -lt $deadline)

    if (-not (Test-BabcordHealth -Url $context.LocalHealthUrl -TimeoutSeconds 2)) {
        throw "Babcord did not become healthy within $StartupTimeoutSeconds seconds. Check $($context.LogDir)."
    }
}

if (-not $SkipTunnel) {
    $tunnel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    if ($null -eq $tunnel) {
        Write-Warning 'The cloudflared Windows service is not installed. Local Babcord is online, but the public domain is not connected.'
    }
    elseif ($tunnel.Status -ne 'Running') {
        try {
            Start-Service -Name 'cloudflared'
            (Get-Service -Name 'cloudflared').WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
            Write-Host 'Cloudflare Tunnel is running.' -ForegroundColor Green
        }
        catch {
            Write-Warning "Babcord is locally healthy, but Cloudflare Tunnel could not be started: $($_.Exception.Message)"
        }
    }
}
