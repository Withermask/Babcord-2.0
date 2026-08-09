# Babcord on your Windows computer

> **This page is the Cloudflare Tunnel deployment option.** For the direct home-server design with Caddy, router forwarding, a GitHub-updated local client, and one-click batch files, use [DIRECT-HOSTING.md](./DIRECT-HOSTING.md). Do not combine the Tunnel networking steps with the direct-hosting steps.

This folder turns one personal Windows computer into the Babcord host. Babcord's accounts, SQLite database, messages, logs, attachments, exports, and backups stay on that computer. Cloudflare Tunnel supplies the public `https://babcord.withermask.net` address without opening a router port or publishing the home's IP address.

The deployment is intentionally native: Node.js 24 runs the app, Node's built-in SQLite support stores the data, Windows Task Scheduler starts and watches it, and `cloudflared` runs as a Windows service. Docker and PostgreSQL are not used.

## Exact production topology

```text
file:// Babcord launcher on Windows or Chromebook
                    |
             HTTPS and WSS
                    |
       babcord.withermask.net (Cloudflare)
                    |
        outbound-only named Tunnel
                    |
       cloudflared Windows service
                    |
          http://127.0.0.1:8080
                    |
           Node 24 Babcord server
                    |
     SQLite + attachments on local NTFS disk
```

There is no inbound router forwarding. Babcord must never listen on `0.0.0.0` or the computer's LAN address. Cloudflare Tunnel supports WebSockets, so the same hostname carries API requests, realtime chat, downloads, health checks, and client update files. See Cloudflare's [Tunnel routing guide](https://developers.cloudflare.com/tunnel/routing/) and [WebSocket confirmation](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/).

## What you need

- A supported, fully updated Windows 11 computer. Windows 10 is no longer a safe long-term server choice.
- A fixed local NTFS disk, preferably an SSD, with at least 100 GB free.
- A wired connection when possible and at least 10 Mbps upload speed.
- Node.js 24 installed for all users. Confirm with `node --version`.
- `withermask.net` using Cloudflare DNS and a Cloudflare account protected by MFA.
- The current `cloudflared` Windows executable.
- A second encrypted disk or trusted encrypted destination for off-computer backups.
- Administrator access to Windows for the one-time setup.

The host must stay powered on. In Windows power settings, allow the display to turn off but set sleep and hibernation to **Never** while plugged in. Schedule Windows restarts for quiet hours. Babcord will be unavailable during power, internet, Windows, or Tunnel outages; the client immediately shows its server-unreachable screen.

Production permits up to 30 registrations per public IP per hour so a class sharing one school NAT address can onboard. Login protection remains 20 attempts per IP per 15 minutes, with a separate 10-attempt account-name guard. These are Babcord anti-abuse controls, not hosting-provider quotas.

## First-time setup

Open **PowerShell as Administrator**, then run these commands from the release folder. Replace the sample path if the folder is elsewhere.

```powershell
Set-Location -LiteralPath 'G:\Babcord 2.0'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\deployment\scripts\Initialize-BabcordHost.ps1 -InstallDependencies
```

Setup creates protected folders under `C:\ProgramData\Babcord`, restricts both data and the active code release to the current owner, Windows administrators, and `SYSTEM`, generates cryptographic server secrets, and displays a temporary global-admin password once. Save it privately. The committed [config.example.env](./config.example.env) contains no secrets; the generated configuration is `C:\ProgramData\Babcord\config\babcord.env` and must never be committed, emailed, or posted.

Next, add the defense-in-depth firewall rule. It blocks LAN/internet sources while leaving the same-computer Tunnel connector able to use loopback:

```powershell
.\deployment\scripts\Set-BabcordFirewall.ps1 -ApplyBlockRule
```

Then configure the named Tunnel as described in [cloudflared/README.md](./cloudflared/README.md), and install its Windows service:

```powershell
.\deployment\scripts\Install-CloudflareTunnel.ps1
```

Finally, register automatic startup, monitoring, and backup tasks:

```powershell
.\deployment\scripts\Register-BabcordTasks.ps1
.\deployment\scripts\Start-Babcord.ps1
.\deployment\scripts\Get-BabcordStatus.ps1
```

All status rows should be healthy, and **Network binding** must say **Loopback only**. Open `https://babcord.withermask.net/health` in a separate browser or phone to confirm the public path.

Sign in with the bootstrap account, immediately regenerate and securely save its recovery codes in account settings, and change its password. Then remove the temporary bootstrap password from the private host configuration:

```powershell
.\deployment\scripts\Clear-BabcordBootstrapSecret.ps1
.\deployment\scripts\Stop-Babcord.ps1 -KeepTunnel
.\deployment\scripts\Start-Babcord.ps1
```

## The three automatic tasks

`Register-BabcordTasks.ps1` creates only these tasks, all running as Windows `SYSTEM`:

| Task | Purpose |
|---|---|
| Babcord Application | Starts `node server/src/index.mjs` through a logging wrapper after Windows starts and restarts it after failures. |
| Babcord Health Monitor | Checks local and public `/health` every five minutes and attempts a safe restart. |
| Babcord Daily Backup | Creates a verified SQLite/data snapshot at 2:00 AM and applies backup retention. |

The application release must live on a fixed local disk. A mapped drive is not visible reliably to a boot-time `SYSTEM` task, so task registration rejects it.

Cloudflare installs its own `cloudflared` Windows service with automatic startup. Cloudflare recommends service mode for host availability; see its [Windows service guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/).

## CORS and the local `file://` client

The production server configuration permits exactly:

- `Origin: null`, which Chrome sends for the local `file://` launcher.
- `https://babcord.withermask.net`, for the hosted client/update surface.

`Origin: null` is not trusted as identity. Every private request still needs a bearer session token and server-side permission checks. Cross-site credential cookies are not used. Do not broaden CORS to `*`, and do not add another web origin without reviewing it. The server must continue answering CORS preflight `OPTIONS` requests and WebSocket authentication from the local client.

## Data locations

```text
C:\ProgramData\Babcord\
  config\babcord.env          private secrets and settings
  data\babcord.sqlite         accounts, messages, permissions, audits
  data\attachments\          uploaded files, profile images, and community icons
  backups\                    routine disaster-recovery snapshots
  exports\                    explicit admin log exports
  logs\                       server and health-monitor output
  state\                      local process tracking
```

Never put the live `data` folder in OneDrive, Dropbox, Google Drive, or another live-sync folder. Those tools can interfere with SQLite. Copy completed backup folders to an encrypted off-computer destination instead.

Versioned launcher/client assets live in the active code release's `client` folder. They change with application releases and are not user data.

## Daily commands

```powershell
# Show local app, public domain, Tunnel, binding, disk, and backup status
.\deployment\scripts\Get-BabcordStatus.ps1

# Create a verified backup immediately
.\deployment\scripts\Backup-Babcord.ps1

# Decrypt a protected audit export for local review (prompts for its password)
.\deployment\scripts\Open-BabcordLogExport.ps1 -InputFile 'C:\ProgramData\Babcord\exports\babcord-logs-YYYY-MM-DD.bclog'

# Stop the app and public Tunnel
.\deployment\scripts\Stop-Babcord.ps1

# Start the app and public Tunnel
.\deployment\scripts\Start-Babcord.ps1

# Audit loopback exposure and firewall state without changing anything
.\deployment\scripts\Set-BabcordFirewall.ps1
```

See [OPERATIONS.md](./OPERATIONS.md) for routine checks and outage handling, [UPDATES.md](./UPDATES.md) for side-by-side updates and rollback, [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md) for a tested restore procedure, and [SECURITY-CHECKLIST.md](./SECURITY-CHECKLIST.md) before allowing real users.

## Important limitations

- Availability depends on this computer, its power, and its home internet.
- Cloudflare is the public connection layer, not the database host. It cannot recover lost local data.
- Routine backups may briefly preserve records that the live 30-day purge has removed. They are highly sensitive, automatically expire after 14 days by default, and are for full disaster recovery—not browsing old conversations.
- Unfiltered `.zip`, `.html`, and `.htm` uploads are intentionally allowed by product policy. The application must force them to download; operators and users should treat them as untrusted files.
- Decrypted audit-export JSON is highly sensitive and is not automatically expired. Keep it encrypted whenever possible and remove any temporary decrypted copy after review.
- Voice controls are placeholders in Version 1; this host runs no voice service.
