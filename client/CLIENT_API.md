# Babcord client integration contract

This folder contains the no-framework browser client source and the permanent portable launcher. `Open Babcord.html` is opened from `file://`; it checks GitHub for a verified complete client, caches the last-known-good copy, and runs that HTML locally. The home HTTPS address is embedded in the complete downloaded client, not stored as a separate field in the GitHub descriptor. `index.html` can still run directly from `file://` for localhost development.

The canonical backend route reference is [`../server/API.md`](../server/API.md). This document records the response shapes and browser behavior the client depends on.

## Configuration and distribution

- `Open Babcord.template.html` is the permanent launcher's source template.
- `scripts/build-portable-client.mjs` inlines `index.html`, `config.js`, `app.css`, and `app.js` into one complete client.
- The build embeds a required HTTPS `apiOrigin`, client version, and home IPv4 metadata in that complete client.
- It writes the immutable client as `releases/clients/<sha256>.html`.
- It writes `releases/latest.json` and a launcher configured with that descriptor's raw GitHub URL.
- `client/Open Babcord.html` is the permanent local file distributed once to users.
- The client has no npm, CDN, font, image, or framework runtime dependency. GitHub is used only to download updates.

For localhost development, open `index.html?api=http://127.0.0.1:8080`. An optional realtime override is `&ws=ws://127.0.0.1:8080/realtime`; `index.html?preview=1` is the UI-only demo. The generated production client uses the origin embedded at build time. API requests use `${apiOrigin}/api`, and health/realtime routes use that same origin.

The direct host keeps the backend on `127.0.0.1:8080`; Caddy is the only public listener and supplies HTTPS/WSS on ports 80/443. The backend may still serve `/client/` for diagnostics and compatibility, but the permanent direct-host launcher does not load its application from that route.

## CORS and `file://`

The complete client runs in the permanent `file://` launcher's sandboxed `srcdoc` frame and has an opaque browser origin (`Origin: null`). A directly opened `index.html` also sends `Origin: null`. The backend must therefore:

- allow the literal `null` origin and the production HTTPS origin;
- answer `OPTIONS` preflights;
- allow `GET, POST, PATCH, PUT, DELETE, OPTIONS`;
- allow `Authorization` and `Content-Type` request headers;
- expose normal JSON/error responses without requiring cookies.

Authentication is a Bearer token, not a cookie, so credentialed CORS is unnecessary. `Origin: null` is transport compatibility, not authentication; every private request still requires its session token and server-side authorization.

## Startup and automatic updates

On every open, the permanent launcher fetches `releases/latest.json` from its configured raw GitHub URL. The descriptor has an exact schema and contains no IP address or server-origin field:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "clientUrl": "https://raw.githubusercontent.com/OWNER/REPOSITORY/main/releases/clients/SHA256.html",
  "sha256": "SHA256",
  "sizeBytes": 123456,
  "format": "babcord-single-html-v1"
}
```

The launcher downloads only HTTPS GitHub URLs, verifies the declared size, SHA-256, HTML format, and embedded version, then stores the verified HTML in IndexedDB with a localStorage fallback. A changed SHA triggers an update even when the version string did not change. It runs the client with `iframe.srcdoc`, so GitHub stores the downloadable update but does not host the running application.

If the GitHub check or download fails, the launcher re-verifies and runs its last-known-good cached client with a visible stale warning. If no verified cache exists, startup stops with a retryable error. A failed or mismatched download never replaces the good cache. Publishers upload the immutable client first and update `latest.json` last.

After the verified application starts, `GET /health` at its embedded server origin must return HTTP 200 JSON. The client accepts a simple object such as:

```json
{
  "ok": true,
  "version": "1.0.0"
}
```

The direct portable build embeds `serverManifestEnabled: false`, so GitHub `latest.json` is its sole update authority. The source/legacy server-hosted client can still use the backend compatibility manifest at `GET /client/manifest.json` and enforce its `minimumClientVersion`. A failed health request immediately shows the Server unreachable screen and Retry button.

## Common protocol

- Protected calls send `Authorization: Bearer <token>`.
- JSON request bodies use `Content-Type: application/json`.
- Successful empty mutations may return HTTP 204.
- Errors use `{ "error": { "code": "...", "message": "...", "details": {} } }`.
- IDs may be numbers or strings; the client compares them as strings.
- All timestamps are Unix milliseconds. ISO strings are also rendered defensively.
- List responses may be a bare array, `{items:[...]}`, or the documented named wrapper; named wrappers are preferred.

## Required response shapes

Authentication:

- `POST /api/auth/register` -> `{token,user,recoveryCodes}`.
- `POST /api/auth/login` and `/api/auth/recover` -> `{token,user}`.
- `GET /api/me` -> `{user}`; the user includes `id`, `username`, `displayName`, `avatarUrl`, and `globalRole`.
- `GET /api/me/sessions` -> `{sessions}`.

Initial application data:

- `GET /api/servers` -> `{servers}`.
- `GET /api/dms` -> `{conversations}`.
- `GET /api/servers/:id` -> `{server,channels,roles,permissions,member}`. `permissions` is the effective numeric bitmask and is required for delegated management UI.
- `GET /api/servers/:id/members` -> `{members}` with each item shaped as `{user,nickname,joinedAt,mutedUntil,roleIds}`.
- Message list routes -> `{messages,nextCursor?,hasMore?}`.

Messages include `id`, `author`, `content`, `createdAt`, optional `editedAt`, `deletedAt`, `replyTo`, `attachments`, `mentions`, and `reactions`. Reactions are `{emoji,count,mine?}`. The current backend omits `mine`; this client safely remembers its own reaction toggles per account/device so they remain removable after a refresh on that device.

Server permission bits:

| Bit | Permission |
| ---: | --- |
| 1 | View channels |
| 2 | Send messages |
| 4 | Manage messages |
| 8 | Manage channels |
| 16 | Manage roles |
| 32 | Manage server |
| 64 | Manage invites |
| 128 | Kick members |
| 256 | Ban members |
| 512 | Timeout members |
| 1024 | View audit log |
| 2048 | Manage Discovery |
| 4096 | Administrator; bypasses channel overrides |

## Files and protected media

The composer accepts up to four attachments. Images are limited to 5 MiB and other files to 10 MiB. Allowed extensions are:

`png jpg jpeg gif webp pdf txt docx pptx xlsx zip html htm`

No content filtering is performed on ZIP, HTML, or HTM files. The server remains responsible for safe storage headers: serve downloads as attachments, use `X-Content-Type-Options: nosniff`, and do not host user HTML as executable same-origin pages.

Uploads use the raw attachment/avatar/icon routes documented by the server and include Bearer authorization. Protected images and downloads are fetched as authenticated blobs; access tokens are never placed in URLs.

## Realtime

The client requests a short-lived ticket with `POST /api/realtime/ticket`, then opens `/realtime?ticket=...`. It supports reconnection, heartbeat traffic, and these event families:

- `message.created`, `message.updated`, `message.deleted`;
- `typing.started`, `typing.stopped`;
- `presence.updated`;
- `channel.*` and `server.*` refresh events.

Channel/server refreshes re-fetch `GET /api/servers/:id`, including category mapping and updated effective permissions.

## Administrative safeguards

Platform administration depends on the `/api/admin/*` routes in the canonical API reference. In particular:

- DM inspection requires a reason and explicit acknowledgement before `/api/admin/dms/open`.
- Inspection must be closed through `/api/admin/dms/:id/close`.
- Messages sent during inspection use the backend Administration flag/endpoint and display only as **Administration** to participants; the real administrator remains in protected audit records.
- Admin server entry uses the normal server detail endpoints. The backend, not the client, grants global authority.
- When a global administrator kicks or bans an ordinary server owner, the request also includes `{transferToUserId,password,confirmName}`. The successor must be another active current member and `confirmName` must exactly match the server name.
- Server and platform mute requests use a finite `durationMinutes` or `indefinite:true`; removal is explicit with server `unmute:true` or platform `action:"unmute"`. The year-9999 sentinel is displayed as **Until removed**.
- The platform owner manages administrator access through `PATCH /api/admin/users/:id/role` with `{role,password,confirmUsername}`. The target account is disconnected and must sign in again.
- The current platform owner can transfer ownership with `POST /api/admin/owner/transfer` and `{userId,password,confirmUsername}`. Both accounts are signed out, the target becomes owner, and the former owner becomes an administrator.
- Exports use `POST /api/admin/logs/export` with the administrator's current Babcord password. The password both reauthenticates the administrator and encrypts the downloaded `.bclog` archive.
- Deleting visible content does not delete its protected log record before 30 days. Logs retain the original content and record the deletion timestamp.
- Global administrators receive daily expiry warnings during the five days before purge through `/api/admin/notifications`.

The server is always the source of truth for authorization, rate limits, moderation protection, mandatory Babcock membership, log retention, and account deletion behavior. Hiding a control in this client is usability—not a security boundary.
