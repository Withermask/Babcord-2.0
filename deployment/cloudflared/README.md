# Connect `babcord.withermask.net`

> **Alternative hosting mode:** This page applies only when choosing Cloudflare Tunnel. For direct home hosting with Caddy, router TCP 80/443 forwarding, and the GitHub-updated local launcher, use [../DIRECT-HOSTING.md](../DIRECT-HOSTING.md). Do not run both public connection methods for one Babcord instance.

Use one **remotely managed named Cloudflare Tunnel**. It provides a stable hostname even when the home's public IP changes and requires no router port forwarding.

## Dashboard setup

1. Confirm `withermask.net` is active in the correct Cloudflare account and the account has MFA.
2. In Cloudflare, open **Networking → Tunnels** and create a Cloudflared tunnel named `Babcord-Windows`.
3. Choose the Windows connector. Keep the displayed connector token private.
4. Add a **Public Hostname** with:
   - Subdomain: `babcord`
   - Domain: `withermask.net`
   - Type: `HTTP`
   - URL: `127.0.0.1:8080`
5. Save. Cloudflare creates the proxied DNS route for `babcord.withermask.net`.
6. On the host, run `deployment\scripts\Install-CloudflareTunnel.ps1` as Administrator. Paste the token only into its hidden prompt.
7. Confirm the connector says **Healthy** in Cloudflare and run `deployment\scripts\Get-BabcordStatus.ps1`.

Cloudflare's current guided procedure is documented in [Set up Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/). Do not create an `A` or `AAAA` record pointing to the home IP.

## Cloudflare settings

- Keep WebSockets enabled. Tunnel supports them natively.
- Do not put a Cloudflare Access login page in front of Babcord; the `file://` client and its WebSocket cannot complete that browser gate. Babcord provides its own authentication.
- Do not use a “Cache Everything” rule. Bypass caching for `/api/*`, `/realtime*`, `/health`, `/attachments/*`, and `/client/manifest.json`.
- Versioned public client assets may be cached because their names change with each release.
- Keep HTTPS enabled at the edge. The short hop from `cloudflared` to `127.0.0.1:8080` stays on the same computer.
- Never publish the database, SMB, RDP, PowerShell remoting, or the app's port directly.

## Why the service uses a token

The recommended dashboard-managed tunnel stores its connector token in the protected Windows service. The installation script prompts without echoing it, does not save it in this repository, and refuses to replace an existing `cloudflared` service.

If a token is exposed, rotate it in Cloudflare immediately and reinstall the connector. A token permits a connector to join that tunnel; it is a secret.

## Locally managed alternative

[config.yml.example](./config.yml.example) is included only for operators who deliberately choose a locally managed tunnel. Replace placeholders in a private copy under `C:\ProgramData\Babcord\cloudflared`, place the tunnel credential JSON there, validate with `cloudflared tunnel ingress validate`, and keep the final catch-all `http_status:404` rule. Do not use token-managed and locally managed configurations at the same time.
