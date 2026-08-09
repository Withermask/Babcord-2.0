# Disaster recovery

Backups matter only after a restore has been tested. Run a planned restore drill before real users depend on Babcord and at least monthly afterward.

## What a completed backup contains

Every `babcord-backup-<UTC time>-<suffix>` folder contains:

- `backup-manifest.json`, including format, time, app version, byte counts, and database SHA-256.
- `data`, containing the verified SQLite snapshot and uploaded content.

The private host configuration and Cloudflare token are deliberately not copied into routine data backups. Keep a separate encrypted recovery copy of the private configuration, and keep Cloudflare account recovery methods safe. Never store either in the repository.

## Restore a selected backup

1. Confirm the backup folder is on a healthy local or attached disk.
2. Open PowerShell as Administrator in the release folder.
3. Stop Babcord and its Tunnel.
4. Run the restore script with the exact backup folder.

```powershell
.\deployment\scripts\Stop-Babcord.ps1
.\deployment\scripts\Restore-Babcord.ps1 -BackupPath 'E:\Babcord Backups\babcord-backup-20260803T060000Z-a1b2c3d4'
```

The script will not modify data until all of these are true:

- The path is absolute and the folder contains a recognized manifest.
- The database stays inside the snapshot data folder.
- The recorded SHA-256 matches.
- SQLite `quick_check` passes.
- Babcord is stopped and its port has no listener.
- A safety backup of current live data succeeds, when current data exists.
- The operator types the backup's exact timestamp at the confirmation prompt.

Restore stages and verifies a full copy first. It also copies current data to a timestamped `data-before-restore-*` folder before replacing the live directory. If the new live copy fails, the script automatically copies the preserved data back.

5. Start Babcord and run status:

```powershell
.\deployment\scripts\Start-Babcord.ps1
.\deployment\scripts\Get-BabcordStatus.ps1
```

6. Verify login, the mandatory Babcock server, several server/DM histories, attachments, admin logs, and client updates.
7. Keep the `data-before-restore-*` folder until the owner accepts the recovery. Delete it later only after independently checking the live data and at least one backup. The restore script intentionally does not delete it.

## Total disk loss or replacement computer

1. Install a supported Windows version, Node 24, and `cloudflared`.
2. Copy a known-good Babcord code release to a fixed local disk.
3. Run `Initialize-BabcordHost.ps1` to recreate the folder structure.
4. Restore the separately protected `babcord.env`, or create a new one with the same public settings and secrets.
5. Copy a completed backup folder to the new computer and run the guarded restore.
6. In Cloudflare, rotate the connector token and install the new connector. Do not reuse a token suspected of exposure.
7. Register tasks, start, and verify.

If the original `BABCORD_SECRET` is lost, existing sessions become invalid. If the recovery pepper is lost, existing recovery codes may become unusable. The SQLite data still exists, but administrative account recovery will require the product's documented owner-recovery process.

## Roll back a failed restore

Stop Babcord. The restore process created a safety backup immediately before replacement; select that exact completed `babcord-backup-*` folder and run the guarded restore process again. The script also prints the `data-before-restore-*` preservation path for expert manual recovery. Keep every copy until recovery is accepted.

If there is any uncertainty about the exact paths, stop and inspect them; never recursively delete or move a drive root, `C:\ProgramData`, the repository root, or a computed wildcard.
