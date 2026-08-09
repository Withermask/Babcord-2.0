# Updates and rollback

> **Hosting-mode note:** The client-update section on this page describes the original Cloudflare Tunnel/server-hosted-client mode. Direct home hosting uses GitHub `latest.json`, an immutable verified complete HTML client, and the permanent local launcher described in [DIRECT-HOSTING.md](./DIRECT-HOSTING.md). The side-by-side server release, backup, migration, and rollback rules still apply to both modes.

Use side-by-side release folders. Never unpack a new release over the running one. Babcord data lives in `C:\ProgramData\Babcord`, so changing code folders does not replace accounts or messages.

## Prepare a release

1. Download or copy the intended release from the trusted project source.
2. Place it in a new fixed-disk folder, for example `C:\Babcord Releases\1.1.0`.
3. Confirm it contains `server\src\index.mjs`, `server\package.json`, `client`, and `deployment`.
4. Install the release's locked server dependencies:

```powershell
Set-Location -LiteralPath 'C:\Babcord Releases\1.1.0\server'
npm.cmd ci --omit=dev
npm.cmd test
```

5. Review the release notes for database migrations, minimum client version changes, and security actions.

## Activate it

From the currently active release, make a data backup and stop Babcord. Then use the new release's deployment scripts:

```powershell
.\deployment\scripts\Backup-Babcord.ps1
.\deployment\scripts\Stop-Babcord.ps1 -KeepTunnel

Set-Location -LiteralPath 'C:\Babcord Releases\1.1.0'
.\deployment\scripts\Register-BabcordTasks.ps1 -ReplaceExisting
.\deployment\scripts\Start-Babcord.ps1
.\deployment\scripts\Get-BabcordStatus.ps1
```

Re-registering tasks is the explicit switch: it points automatic startup and monitoring at the new release folder. The private config and data paths stay unchanged.

Verify registration/login, server and DM messages, attachments, admin pages, Discovery, CORS from the local `file://` launcher, realtime reconnect, and the update manifest. Keep the previous code release and pre-update data backup.

## Client auto-updates

The permanent local launcher checks the server health and then loads the current client directly from `https://babcord.withermask.net/client/index.html`. The hosted client checks the update manifest and blocks versions below `minimumVersion`, so every normal launch or refresh receives the active server release without replacing the local file. Publish the new client only after its files and manifest have been tested together.

The launcher itself cannot silently overwrite a local `file://` file. A rare launcher-format/security change must show **Launcher Update Required** and offer a deliberate download.

The manifest includes asset hashes for release verification by the operator, but Version 1 does not maintain an offline browser cache or verify those hashes inside the launcher. Keep the prior side-by-side code release so the operator can roll back the server-hosted client.

## Roll back code

If the new release is unhealthy:

1. Stop it with its own `Stop-Babcord.ps1 -KeepTunnel`.
2. Return to the previous release folder.
3. If the update did not change the data schema, re-register tasks there with `-ReplaceExisting`, start, and verify.
4. If the update changed data incompatibly, follow its release-specific migration rollback instructions and restore the pre-update data snapshot with the guarded restore script.

Never guess whether a migrated database is backward-compatible. When release notes do not explicitly confirm it, restore the matching data backup.

## Cloudflared updates

Cloudflare documents that a Windows `cloudflared` service update restarts the connector and drops existing WebSockets briefly. Schedule it as maintenance, update only from Cloudflare's official distribution, restart the service, and run the status script. See [Cloudflare's update guide](https://developers.cloudflare.com/tunnel/downloads/update-cloudflared/).
