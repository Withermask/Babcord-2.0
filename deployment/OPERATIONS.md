# Babcord operator runbook

> **Hosting-mode note:** Network and outage steps on this page describe the original Cloudflare Tunnel mode. In direct home-host mode, use the root `Start/Stop/Status Babcord Direct.bat` files and check Caddy plus router TCP 80/443 instead of `cloudflared`. See [DIRECT-HOSTING.md](./DIRECT-HOSTING.md). Backup, retention, admin-review, disk, and Windows-maintenance procedures remain shared.

## Every day

Open the global-admin dashboard and check:

- Service alerts and failed login/registration spikes.
- Disk-space and backup warnings.
- Admin DM-access events and use of the public `Administration` handle.
- The five-day log-expiration banner, when present.

On the Windows host, run:

```powershell
Set-Location -LiteralPath 'G:\Babcord 2.0'
.\deployment\scripts\Get-BabcordStatus.ps1
```

Healthy production means local and public health pass, Tunnel is running, the listener is loopback-only, a recent backup exists, and the data disk has comfortable free space. Investigate below 20 GB; stop uploads or increase storage below 10 GB.

## Five-day log-purge warnings

Babcord retains protected message/audit content for 30 rolling days. The application performs retention daily and sends every global administrator one warning per day during the five days before each expiration batch:

- Day 5, 4, and 3: normal warning.
- Day 2: high-priority warning.
- Day 1: final warning.
- Purge day: completion summary.

The warning links to the expiring-record review and export action. If logs are needed for an authorized investigation, a global admin must create the export before the displayed deadline and move it to an encrypted, access-controlled location. An export does not change the live purge deadline, and the export action is itself audited.

The Windows task does not perform the application purge; the Node server checks retention hourly and sends at most one warning batch per day. `BABCORD_LOG_RETENTION_DAYS=30`, `BABCORD_LOG_WARNING_DAYS=5`, and `BABCORD_LOG_WARNING_HOUR=9` make the policy explicit in the private configuration.

Routine disaster-recovery backups are different from admin exports. They are full snapshots, default to 14-day retention, and may contain content removed from the live database. Never use them to bypass the admin investigation workflow.

## Backups

The daily task calls `Backup-Babcord.ps1` at 2:00 AM. It briefly pauses the app (leaving the Tunnel connected) so SQLite and attachments represent one moment, then:

1. Copies non-database data without following directory junctions.
2. Uses Node 24's SQLite online-backup API for a consistent database snapshot.
3. Runs SQLite `quick_check` on the result.
4. records a SHA-256 database hash and manifest.
5. Removes the snapshot's `.incomplete` marker only after all checks pass.
6. Removes only recognized Babcord backup folders older than the configured retention.

The app starts again automatically in a `finally` step even when the snapshot fails. During the short pause, clients show the normal reconnecting/server-unreachable state and never receive a false send confirmation. `-KeepApplicationRunning` exists for an emergency database-only-style snapshot, but it can race with attachment uploads/deletions and is not used by the production task.

Incomplete snapshots contain a `.incomplete` marker and are never treated as restorable backups.

Once a day, copy the newest completed `babcord-backup-*` folder to a second encrypted physical disk or trusted encrypted off-site destination. Do not make a live-sync tool watch the SQLite data folder.

## If clients say “Server unreachable”

1. Run `Get-BabcordStatus.ps1`.
2. If **Local application** is unhealthy, inspect `C:\ProgramData\Babcord\logs` and run `Start-Babcord.ps1`.
3. If local is healthy but public is unreachable, check the `cloudflared` Windows service, home internet, and the Tunnel connector status in Cloudflare.
4. If both are healthy, test another network/device and verify the client is using `https://babcord.withermask.net`.
5. If **Network binding** says **UNSAFE**, stop Babcord immediately and restore `BABCORD_HOST=127.0.0.1` before restarting.

Do not open port 8080 on the router as a workaround.

Backup and restore create a small `*.maintenance.json` marker in `C:\ProgramData\Babcord\state`. The monitor will not restart the app while one exists. If Windows or PowerShell crashes mid-maintenance, first confirm no backup/restore PowerShell process or task is running and inspect its log/data output; only then remove that one exact marker. Never clear a marker merely to silence a warning.

## Planned maintenance

Warn users in advance. Then:

```powershell
.\deployment\scripts\Backup-Babcord.ps1
.\deployment\scripts\Stop-Babcord.ps1
# perform the maintenance
.\deployment\scripts\Start-Babcord.ps1
.\deployment\scripts\Get-BabcordStatus.ps1
```

Stopping the Tunnel makes the client show its immediate unreachable message. `-KeepTunnel` may be used when only the app must restart; clients will still see the unreachable state while `/health` is down.

## Weekly

- Confirm at least one recent backup exists on another encrypted device.
- Review the three Babcord tasks in Task Scheduler and their last result.
- Review `C:\ProgramData\Babcord\logs\health-monitor.log` for repeated failures.
- Check Windows Update, Node 24 security releases, and `cloudflared` updates.
- Confirm no router port forwards exist for 8080, RDP, SMB, or the database.
- Run the firewall/binding audit: `Set-BabcordFirewall.ps1` with no change flag.

## Monthly

- Perform a restore drill on a separate temporary copy or during a planned window.
- Confirm global admins understand the 30-day purge/export workflow.
- Review all global-admin accounts and remove access no longer needed.
- Verify Cloudflare MFA, Tunnel connector status, and account recovery methods.
- Check attachment growth and forecast disk capacity.

## Windows shutdown and updates

Babcord cannot stay online while Windows is off. Configure active hours, but never disable security updates. After any restart, wait one minute and run the status script. If the BIOS supports **Restore on AC Power Loss**, enabling it helps after an outage. A UPS is strongly recommended for the host and router.
