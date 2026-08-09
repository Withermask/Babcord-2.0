# Babcord

Babcord is a self-hosted school messaging platform designed for a personal Windows host and a portable `file://` launcher. It supports direct home hosting through Caddy as well as the original Cloudflare Tunnel option. In direct mode, the permanent local launcher obtains a verified, complete client update from GitHub; that downloaded HTML contains the current home HTTPS address and still runs locally.

Version 1 includes:

- username/password registration with one-time recovery codes and account deletion;
- the mandatory, protected Babcock community plus user-created servers;
- categories, text channels, visible voice-channel placeholders, roles, permission overrides, invites, ownership controls, discovery opt-in, and server deletion;
- direct messages, DM requests, blocking, and a visible call button that reports **Feature Under Construction!**;
- message editing/deletion, reactions, mentions, replies, search, typing/presence updates, and small attachments;
- owner, moderator, and platform-admin actions for kicks, bans, mutes, reports, and audit review;
- explicit, audited admin opening of DMs and anonymous-to-users **Administration** replies;
- rolling 30-day audit retention, deleted-content preservation until expiry, daily five-day purge warnings, and encrypted exports;
- a clean responsive interface for Chrome on Windows and Chromebooks;
- immediate offline feedback and verified automatic client updates from GitHub in direct-host mode.

Voice calling is intentionally a placeholder in Version 1. Voice channels can be created and call controls are visible, but no audio or video service is started.

## Project map

| Path | Purpose |
|---|---|
| `client/` | Permanent portable launcher and browser client source. |
| `server/` | Node.js 24 REST/WebSocket service and SQLite schema. |
| `deployment/` | Windows setup, direct hosting, optional Tunnel hosting, monitoring, backup, restore, and firewall guidance. |
| `releases/` | Complete client HTML and its GitHub update descriptor. |
| `tests/` | Portable-client and contract checks. |
| `app/` | Local visual-preview shell used during development. |

The complete API contract is in [server/API.md](server/API.md). Server configuration and development details are in [server/README.md](server/README.md). For the requested direct home-server setup and one-click startup, use [deployment/DIRECT-HOSTING.md](deployment/DIRECT-HOSTING.md). The original Cloudflare Tunnel runbook remains in [deployment/README.md](deployment/README.md) as an alternative.

## Local development

Install Node.js 24, then run from this folder in PowerShell:

```powershell
npm install
$env:BABCORD_SECRET = 'replace-with-a-long-random-secret'
$env:BABCORD_RECOVERY_PEPPER = 'replace-with-a-different-random-secret'
$env:BABCORD_ADMIN_USERNAME = 'YourAdminUsername'
$env:BABCORD_ADMIN_PASSWORD = 'replace-with-a-long-one-time-password'
npm start
```

The service starts at `http://127.0.0.1:8080`. The permanent `Open Babcord.html` launcher is generated with a GitHub update location during direct-host setup. For a simple localhost development test, open this source client directly in Chrome:

```text
client\index.html?api=http://127.0.0.1:8080
```

The first owner account is created only when the database is empty. Sign in, regenerate and save its recovery codes, change the password, then remove the bootstrap password from the environment before the next restart.

## Verification

```powershell
npm test
npm run build
```

`npm test` runs isolated backend integration coverage and portable-client checks. `npm run build` synchronizes the current client into the local preview and compiles that preview.

## Windows hosting

For direct hosting, follow [deployment/DIRECT-HOSTING.md](deployment/DIRECT-HOSTING.md). The router forwards only TCP 80 and 443 to Caddy; port 8080 is never forwarded and the Babcord service remains bound to `127.0.0.1`. `Start Babcord Direct.bat` detects a changed public IP, embeds the new HTTPS hostname in the complete client, and publishes the matching client and hash descriptor to GitHub.

If direct inbound hosting is unavailable because of CGNAT or blocked ports, follow the alternative [Cloudflare Tunnel runbook](deployment/README.md). Do not combine the two networking procedures.

Before admitting real users, complete every item in [deployment/SECURITY-CHECKLIST.md](deployment/SECURITY-CHECKLIST.md). Keep the host updated, awake while plugged in, and backed up to an encrypted off-computer destination.

## File policy

Images are limited to 5 MB, other allowed files to 10 MB, and messages to four attachments. Avatars and server icons are limited to 2 MB. Allowed extensions are PNG, JPEG, GIF, WebP, PDF, TXT, DOCX, PPTX, XLSX, ZIP, HTML, and HTM.

Per product policy, ZIP/HTML/HTM contents are not inspected or rewritten. They are stored byte-for-byte and served as downloads. Treat them as untrusted files.
