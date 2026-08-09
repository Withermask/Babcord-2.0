# Direct home hosting with a GitHub-updated local client

This is the guide for running Babcord directly from a Windows computer at home, without Cloudflare Tunnel. The people using Babcord still open a local `file://` launcher in Chrome. GitHub is used only to distribute a verified, complete client update; it does not run Babcord and it does not store accounts, messages, or attachments.

## How this version works

```text
Local Open Babcord.html
        |
        | checks for an update
        v
GitHub: latest.json + clients/<verified-hash>.html
        |
        | downloads and verifies the complete client
        v
Client runs locally from the permanent launcher
        |
        | HTTPS and secure WebSocket
        v
babcord-203-0-113-10.sslip.io (example address)
        |
        | router forwards only TCP 80 and 443
        v
Caddy on the home Windows computer
        |
        | private loopback connection
        v
Babcord at 127.0.0.1:8080
```

The current home address is embedded inside the content-addressed complete client HTML. It is not a separate field in the GitHub update descriptor. When the public IP changes, the one-click starter builds and publishes a new complete client containing the new address. Existing launchers download it the next time they open.

The permanent launcher does not silently replace its own file. It verifies the downloaded client with SHA-256, keeps the last verified copy in browser storage, and runs that copy locally. This is still a local-client design, not a GitHub-hosted web app.

## Before starting

You need all of the following:

- A supported, updated Windows 11 computer that can remain powered on and awake.
- Node.js 24 on that computer. Setup can install Caddy automatically through Windows Package Manager.
- Administrator access to Windows and to the home router.
- A public IPv4 address from the internet provider.
- The ability to forward incoming TCP ports 80 and 443 to the Windows computer.
- A public GitHub repository for the update descriptor and immutable client releases.
- A fine-grained GitHub token that can update that repository.
- Chrome clients whose network permits HTTPS downloads from `raw.githubusercontent.com`.
- An encrypted backup destination separate from the live computer.

### Check for CGNAT first

This design cannot accept connections through carrier-grade NAT (CGNAT). Compare the router's internet/WAN IPv4 address with the public IPv4 shown by a reputable IP-checking site. If they differ, or the router address is in a private/shared range such as `100.64.0.0/10`, ask the internet provider for a public IPv4 address. If that is unavailable, direct hosting will not work; use the Cloudflare Tunnel option instead.

Some providers also block inbound ports 80 or 443. Confirm they are allowed before relying on this setup.

## One-time setup

### 1. Give the host a stable address inside the home network

In the router, reserve the Windows computer's current local IPv4 address. This is sometimes called a **DHCP reservation** or **static lease**. The reservation prevents the port-forwarding destination from changing after a restart.

Do not expose Remote Desktop, file sharing, the database, or Babcord port 8080.

### 2. Create the router forwards

Forward these two incoming ports to the reserved local address of the Windows computer:

| Internet port | Protocol | Destination port | Used by |
|---:|---|---:|---|
| 80 | TCP | 80 | Caddy certificate setup and HTTPS redirect |
| 443 | TCP | 443 | Caddy HTTPS and secure WebSocket traffic |

Never forward port 8080. Babcord itself must remain bound to `127.0.0.1`; Caddy is the only internet-facing process.

### 3. Prepare the GitHub release repository

Create a public repository and check **Add a README** so its `main` branch exists. GitHub Pages is not required. The launcher must be able to read the descriptor and immutable client without signing into GitHub:

```text
releases/latest.json
releases/clients/<sha256>.html
```

The publisher also places `releases/Open Babcord.html` there as a convenient download copy of the permanent launcher. That copy is distribution only: users save it locally and open the saved `file://` file. GitHub never runs it as the Babcord app.

Each complete HTML client has its SHA-256 value in its filename, so an old and a new client are never confused by a cache. `latest.json` points at the current immutable file. It never contains a server address:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "clientUrl": "https://raw.githubusercontent.com/OWNER/REPOSITORY/main/releases/clients/THE_SHA256_HASH.html",
  "sha256": "THE_SHA256_HASH",
  "sizeBytes": 123456,
  "format": "babcord-single-html-v1"
}
```

The content-addressed HTML downloaded from `clientUrl` contains the current home HTTPS address.

Create a [fine-grained GitHub personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) limited to this one repository, with repository **Contents: read and write** permission. Do not put the token in any HTML file, Git commit, environment file, command-line argument, screenshot, or message. Babcord's token setup stores it in a private, access-controlled file on the host. People using the client never need this token.

### 4. Run the one-click setup

Install Node.js 24 first. Then double-click [Setup Babcord Direct.bat](../Setup%20Babcord%20Direct.bat). It requests Administrator access automatically. Setup installs the locked Babcord server dependencies and attempts to install the official Caddy package through Windows Package Manager. If Caddy cannot be installed automatically, install Caddy from its official source and set its exact path in the private direct-host configuration.

Setup creates private configuration and data folders under:

```text
C:\ProgramData\Babcord
```

Save the one-time administrator password when it is shown. Setup does not guess a GitHub account. Next, double-click [Configure Babcord GitHub.bat](../Configure%20Babcord%20GitHub.bat). Enter the public repository owner and repository name when asked, then paste the fine-grained token into the hidden prompt. The one-click configurator uses the repository's `main` branch. It verifies that the repository is public, writes only the non-secret repository settings to `C:\ProgramData\Babcord\config\direct.env`, and stores the token in a separate access-controlled file. The ordinary configuration never contains the token.

### 5. Start and verify the public server

Double-click [Start Babcord Direct.bat](../Start%20Babcord%20Direct.bat). The starter:

1. Detects the current public IPv4 address.
2. Creates an address such as `https://babcord-203-0-113-10.sslip.io`.
3. Embeds that complete HTTPS address into a new self-contained client.
4. Starts the private Babcord service on `127.0.0.1:8080`.
5. Starts or reloads Caddy on ports 80 and 443.
6. Checks local health and the real public certificate/HTTPS route.
7. Only after those checks pass, publishes the immutable complete client first and `latest.json` second, so a launcher never receives a descriptor before its client exists.
8. Starts a background watcher that checks the public IP every five minutes and safely repeats the update process when needed.

Windows Firewall should allow the exact Caddy program on TCP 80/443 and continue explicitly blocking direct access to port 8080. Do not replace these rules with a broad inbound allow rule.

Use [Status Babcord Direct.bat](../Status%20Babcord%20Direct.bat) to confirm that the local app, loopback binding, Caddy listeners, public HTTPS route, firewall rules, and private GitHub-token file are healthy. The successful Start output confirms publication; the status check deliberately does not download or execute the GitHub client.

If a public test fails from a device connected to the same Wi-Fi, the router may not support NAT loopback. Test from a phone with Wi-Fi turned off before treating that as an outside-network failure.

### 6. Finish the administrator account

Open Babcord, sign in with the temporary administrator credentials, save the recovery codes somewhere secure, and change the password. Clear the bootstrap password using the supplied deployment script after the new password works.

### 7. Give users the permanent local launcher

Copy this one file to each Windows or Chromebook user:

[client/Open Babcord.html](../client/Open%20Babcord.html)

They save it locally and open it in Chrome. It remains their permanent `file://` launcher. If the GitHub download copy is used for initial distribution, save that file to the Chromebook first; do not bookmark or run the raw GitHub URL as a website. Users do not need a GitHub account.

On each launch, it:

1. Reads `releases/latest.json` from GitHub.
2. Downloads its content-addressed client if the verified hash changed.
3. Checks the downloaded size, UTF-8 bytes, client version, and SHA-256 value.
4. Caches only a verified client and runs it locally.
5. Connects to the home HTTPS address embedded in that client.

Keep the launcher's name and GitHub update location stable. A replacement launcher is needed only if the descriptor repository/location itself changes or the launcher update mechanism changes.

## Everyday use

To bring Babcord online, double-click:

[Start Babcord Direct.bat](../Start%20Babcord%20Direct.bat)

When it reports that Babcord is running, the window may be closed; the server, Caddy, and five-minute IP watcher continue in the background. After a Windows restart, run this batch file again.

To check it, double-click:

[Status Babcord Direct.bat](../Status%20Babcord%20Direct.bat)

To take it offline cleanly, double-click:

[Stop Babcord Direct.bat](../Stop%20Babcord%20Direct.bat)

Keep the computer awake, connected to the router, and current with Windows security updates. The normal backup and audit-retention procedures still apply.

## When the public IP changes

While Babcord is running, its background watcher checks every five minutes. It detects a new IPv4 address, builds a client containing the new HTTPS hostname, reloads Caddy, and publishes the matching release files. You can also run `Start Babcord Direct.bat` again to request the check immediately. Users then close and reopen their permanent launcher. The launcher downloads and verifies the new complete client and connects to the new home address.

There can be a short transition while the new certificate is issued and GitHub's raw-file service sees the new commit. During that window, users may see the stale-client warning or **Server unreachable**. Nothing is falsely reported as sent; reopen the launcher after the starter reports success.

The default host uses the public service [sslip.io](https://sslip.io/), which resolves an IP encoded in a hostname. This allows [Caddy's automatic HTTPS](https://caddyserver.com/docs/automatic-https) to obtain normal browser-trusted certificates while still putting the IP inside the client. It adds a third-party DNS dependency: if `sslip.io` is unavailable or changes its service, the generated name will not resolve. An operator-owned hostname can replace it through `BABCORD_DIRECT_PUBLIC_HOST`, but its DNS record and certificate setup must then be kept current separately.

## Publishing an ordinary client update

The direct starter rebuilds and publishes when its configured client version/content or public address changes. The manual building contract, useful for a release test, is:

```powershell
node .\scripts\build-portable-client.mjs `
  --api-origin 'https://babcord-203-0-113-10.sslip.io' `
  --home-ip '203.0.113.10' `
  --version '1.0.0' `
  --github-owner 'OWNER' `
  --github-repo 'REPOSITORY' `
  --github-branch 'main'
```

It produces:

```text
client/Open Babcord.html
releases/Open Babcord.html
releases/clients/<sha256>.html
releases/latest.json
```

Publish the content-addressed HTML first and `latest.json` last. Never publish a descriptor hash from one build with the HTML from another. The provided GitHub publishing script performs the ordered update using the protected token.

## Failure and recovery

### GitHub is temporarily unavailable

The launcher re-verifies and uses its last-known-good cached client and shows that it may be stale. New devices with no cached client cannot start until GitHub is reachable. If the home IP changed after the cached client was created, that cached client cannot discover the new address; GitHub must become available so it can receive the new complete HTML.

### A download or hash check fails

The launcher rejects it and keeps the prior verified client. Do not work around the check. Rebuild and republish both release files, then reopen the launcher.

### Babcord says the server is unreachable

Run `Status Babcord Direct.bat`, then check, in order:

1. Whether the Windows computer is on, awake, and online.
2. Whether Babcord is healthy locally.
3. Whether Caddy is running and its certificate is valid.
4. Whether the router still forwards TCP 80/443 to the reserved local address.
5. Whether the router WAN address still matches the detected public IPv4.
6. Whether the latest GitHub client contains the current generated hostname.
7. Whether the ISP introduced CGNAT or started blocking inbound ports.

### A bad client update was published

Point `latest.json` back to the last known-good content-addressed client, with that exact file's size, version, and SHA-256 value. Because any changed SHA triggers an update, the version string does not have to be changed for emergency recovery, although increasing it is clearer for operators.

### The GitHub token stops working

Create a new fine-grained token with access only to the release repository, run `Configure Babcord GitHub.bat` again to store it, and revoke the old token on GitHub. Never distribute a launcher or client containing a token.

## Security boundaries

- Home IP exposure is intentional in this mode. The generated hostname and downloaded client reveal it.
- HTTPS and secure WebSockets are mandatory. Do not publish an `http://` or raw `ws://` home address.
- Caddy alone listens publicly on TCP 80/443. Babcord remains on `127.0.0.1:8080`.
- Do not forward port 8080, the database, RDP, SMB, PowerShell remoting, or file sharing.
- The GitHub repository contains only public client files and hashes, never server secrets, database data, credentials, attachments, logs, or the publisher token.
- Keep Microsoft Defender, Windows Firewall, Caddy, Node.js, and Windows updated.
- Keep verified Babcord backups on a separate encrypted device.

Before inviting real users, review [SECURITY-CHECKLIST.md](./SECURITY-CHECKLIST.md), applying the direct-host substitutions explained below.

## Do not mix the two hosting modes

The older [deployment/README.md](./README.md), [cloudflared/README.md](./cloudflared/README.md), [OPERATIONS.md](./OPERATIONS.md), [UPDATES.md](./UPDATES.md), and several Cloudflare sections of [SECURITY-CHECKLIST.md](./SECURITY-CHECKLIST.md) describe the alternative Tunnel deployment. They intentionally say to create no router forwards, use `babcord.withermask.net`, run `cloudflared`, and load a server-hosted client. Those instructions conflict with direct hosting and must not be combined with this guide.

For direct hosting, substitute:

| Tunnel documentation says | Direct-host setup uses |
|---|---|
| No router forwarding | Forward TCP 80 and 443 only |
| `cloudflared` service | Caddy |
| `babcord.withermask.net` | The current IP-encoded HTTPS hostname |
| Server-hosted current client | GitHub-downloaded, verified complete HTML run locally |
| No offline client cache | Last-known-good verified browser cache |

The shared safety rules do not change: Babcord stays bound to loopback, port 8080 is never forwarded, CORS permits the local `file://` origin, backups remain essential, and passwords/tokens/secrets never belong in public client files.
