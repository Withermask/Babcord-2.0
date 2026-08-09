# Babcord server API

The Babcord server listens on `127.0.0.1:8080` by default. In production, Cloudflare Tunnel publishes it at `https://babcord.withermask.net`; the process itself should remain bound to localhost.

All timestamps are Unix milliseconds. JSON errors have this stable shape:

```json
{"error":{"code":"MACHINE_READABLE_CODE","message":"Readable explanation","details":{}}}
```

## Browser and authentication contract

- Requests without an `Origin` header, `Origin: null` from `file://`, and the configured `BABCORD_WEB_ORIGIN` are accepted. Other origins receive `403 ORIGIN_NOT_ALLOWED`.
- `OPTIONS` supports `GET, POST, PUT, PATCH, DELETE` and the `Authorization`, `Content-Type`, `X-Babcord-Client-Version`, and `X-File-Name` headers.
- Authenticated routes require `Authorization: Bearer <token>`. Babcord does not use cross-site cookies.
- Sessions expire after 30 days by default and an account can have up to ten active sessions.
- JSON request bodies default to a 1 MB maximum. Messages are limited to 4,000 characters.
- Successful deletes and state-only writes generally return `204 No Content`.

## Public and client endpoints

| Method | Path | Result |
|---|---|---|
| `GET` | `/health` | `{status,serverTime,version,minimumClientVersion}` |
| `GET` | `/client/` | Hosted copy of the portable client |
| `GET` | `/client/config.js` | Portable static client configuration (works from both hosted and `file://` launchers) |
| `GET` | `/client/manifest.json` | Stable version, endpoints, and SHA-256 asset hashes |
| `GET` | `/client/<file>` | Static file from `BABCORD_CLIENT_DIR` |

The launcher may health-check `/health` immediately. A connection failure or timeout should produce the client’s “Babcord Server Unreachable” screen.

## Accounts

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/api/auth/register` | `{username,password,displayName?}`. Returns `{user,token,recoveryCodes}`. Recovery codes are shown once. |
| `POST` | `/api/auth/login` | `{username,password}`. Returns `{user,token}`. |
| `POST` | `/api/auth/recover` | `{username,recoveryCode,newPassword}`. Consumes one code and revokes all sessions. |
| `POST` | `/api/auth/logout` | Revokes the current session. |
| `GET` | `/api/me` | Returns `{user,servers}`. |
| `PATCH` | `/api/me` | `{displayName}`. |
| `DELETE` | `/api/me` | `{password}`. Anonymizes the account and revokes sessions. The owner cannot self-delete. |
| `GET` | `/api/me/sessions` | Active sessions and their device descriptions. |
| `DELETE` | `/api/me/sessions/:id` | Revokes one owned session. |
| `POST` | `/api/me/password` | `{currentPassword,newPassword}`. |
| `POST` | `/api/me/recovery-codes` | `{password}`. Invalidates old codes and returns eight new codes once. |
| `GET` | `/api/users/search?q=` | User picker search; two characters minimum. |
| `PUT` | `/api/users/:id/block` | Blocks DMs with a user. |
| `DELETE` | `/api/users/:id/block` | Removes the block. |
| `PUT` | `/api/me/avatar` | `{attachmentId}` for an uploaded image up to 2 MB. |
| `GET` | `/api/users/:id/avatar` | Authenticated inline avatar bytes. |

User objects are shaped as:

```json
{
  "id": 12,
  "username": "casey",
  "displayName": "Casey",
  "avatarUrl": "/api/users/12/avatar",
  "globalRole": "user",
  "status": "active",
  "createdAt": 1785776400000
}
```

Usernames are case-insensitively unique, 3–32 characters, and limited to letters, numbers, `.`, `_`, and `-`. Passwords must contain 10–256 characters. Passwords use scrypt with a unique salt. High-entropy recovery codes are HMAC-hashed with the configured recovery pepper; session tokens are SHA-256 hashed before storage.

## Servers, channels, roles, and membership

| Method | Path | Body / notes |
|---|---|---|
| `GET` / `POST` | `/api/servers` | List memberships, or create with `{name,description?}`. Default maximum is five owned servers. |
| `GET` / `PATCH` / `DELETE` | `/api/servers/:id` | Get full navigation state, update settings, or delete. The mandatory server rejects deletion. |
| `POST` | `/api/servers/:id/transfer` | `{userId}`; user must be a member. |
| `POST` | `/api/servers/:id/leave` | Owners must transfer first; the mandatory server cannot be left. |
| `GET` / `POST` | `/api/servers/:id/channels` | List visible channels or create `{name,type,topic?,parentId?,position?,userLimit?}`. Types: `category`, `text`, `voice`. |
| `PATCH` / `DELETE` | `/api/channels/:id` | Update or delete a channel, including its persisted `topic`. Voice channels are configuration-only in v1. |
| `PUT` | `/api/channels/:id/permissions` | `{targetType:"role"|"member",targetId,allow,deny}` bitfields. |
| `DELETE` | `/api/channels/:id/permissions/:targetType/:targetId` | Remove an override. |
| `GET` / `POST` | `/api/servers/:id/roles` | List or create `{name,color?,position?,permissions}`. |
| `PATCH` / `DELETE` | `/api/roles/:id` | Update/delete; default role cannot be deleted. |
| `PUT` / `DELETE` | `/api/servers/:id/members/:userId/roles/:roleId` | Assign/remove role. |
| `GET` | `/api/servers/:id/members` | Members, roles, nicknames, and timeout state. |
| `POST` | `/api/servers/:id/kick` | `{userId,reason?}`. |
| `POST` | `/api/servers/:id/ban` | `{userId,reason?,durationMinutes?}`. Omit duration for permanent. |
| `DELETE` | `/api/servers/:id/bans/:userId` | Unban. |
| `POST` | `/api/servers/:id/mute` | `{userId,durationMinutes?,reason?}`. Omit duration to unmute. |
| `GET` / `POST` | `/api/servers/:id/invites` | Manage invites. Creation accepts `{maxUses?,expiresInMinutes?}`. |
| `DELETE` | `/api/invites/:code` | Revoke an invite. |
| `POST` | `/api/invites/:code/join` | Join via invite. |
| `PUT` | `/api/servers/:id/icon` | `{attachmentId}` for an uploaded image up to 2 MB. |
| `GET` | `/api/servers/:id/icon` | Inline icon bytes for members or public Discovery entries. |

The server created with `is_system=1` is the mandatory Babcock server. Startup repairs membership for every active account. It cannot be deleted or left. Global administrators bypass server permissions without needing a membership row.

Permission values can be ORed together:

| Permission | Value |
|---|---:|
| View channel | 1 |
| Send messages | 2 |
| Manage messages | 4 |
| Manage channels | 8 |
| Manage roles | 16 |
| Manage server | 32 |
| Create invites | 64 |
| Kick members | 128 |
| Ban members | 256 |
| Mute members | 512 |
| View audit log | 1024 |
| Manage Discovery | 2048 |
| Server administrator | 4096 |

The backend prevents delegated moderators from granting permissions they do not possess. The owner and platform administrators have the full bitset.

## Text messages and files

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/api/channels/:id/messages?before=&limit=&q=` | Oldest-to-newest page; defaults to 50, max 100. |
| `POST` | `/api/channels/:id/messages` | `{content?,attachmentIds?,replyToId?}`. |
| `PATCH` | `/api/messages/:id` | `{content}`; authors only. |
| `DELETE` | `/api/messages/:id` | `{reason?,confirm?}`. Administrative deletion of another user’s message requires `confirm:true`. |
| `PUT` / `DELETE` | `/api/messages/:id/reactions/:emoji` | Add/remove the caller’s reaction. |
| `PUT` | `/api/channels/:id/read` | `{messageId}`. |
| `POST` | `/api/uploads?filename=<name>` | Raw request bytes, with the file MIME type in `Content-Type`. |
| `GET` | `/api/attachments/:id` | Authenticated file download with `Content-Disposition: attachment` and `nosniff`. |

Allowed names end in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`, `.txt`, `.docx`, `.pptx`, `.xlsx`, `.zip`, `.html`, or `.htm`. Images have a 5 MB limit, other files a 10 MB limit, and messages may attach four files. ZIP, HTML, and HTM payloads are saved byte-for-byte: Babcord does not scan, inspect, unpack, render, sanitize, or rewrite their contents. They are always downloaded rather than executed in the Babcord page.

Deletion immediately sets the visible message content to `null`, records `deletedAt`, and marks attachments deleted. The protected audit event retains the exact last content, attachment metadata, author, deleter, timestamp, and reason until its individual 30-day expiration. Edits likewise write old and new content to protected logs. Physical deleted attachments remain available to authorized logs for the retention period, then maintenance removes them.

Message shape:

```json
{
  "id": 51,
  "channelId": 4,
  "dmId": null,
  "content": "hello",
  "deleted": false,
  "deletedAt": null,
  "editedAt": null,
  "createdAt": 1785776400000,
  "replyToId": null,
  "administration": false,
  "author": {"id":12,"username":"casey","displayName":"Casey","avatarUrl":null},
  "attachments": [],
  "reactions": [{"emoji":"👍","count":2}],
  "mentions": [{"id":13,"username":"jordan","displayName":"Jordan"}]
}
```

Plain `@username` references to active accounts are persisted in `mentions` for notification and highlighting. Mention parsing never grants visibility to a channel or DM the mentioned account cannot otherwise access.

## Direct messages

| Method | Path | Body / notes |
|---|---|---|
| `GET` / `POST` | `/api/dms` | List conversations or create/find a one-to-one DM with `{userId}`. The recipient starts in `pending`. |
| `POST` | `/api/dms/:id/accept` | Accept a message request. |
| `POST` | `/api/dms/:id/decline` | Decline a message request. |
| `GET` / `POST` | `/api/dms/:id/messages` | Same pagination/body as channels. An inspecting admin must add `administration:true` when sending. |
| `PUT` | `/api/dms/:id/read` | `{messageId}`. Admin inspection never changes participant read markers. |

Platform administrators do not see DMs in their regular list. They must open an access session with a reason (see Admin API); it expires after 60 minutes of inactivity. Every open, read, search, attachment download, realtime subscription, administrative message, and close operation records the real administrator internally. Messages sent by an inspecting administrator are serialized only as the protected official identity:

```json
{"id":null,"username":"Administration","displayName":"Administration","avatarUrl":null,"official":true}
```

The real administrator ID is present only in protected audit logs. Administrators cannot edit user messages or impersonate either participant.

## Discovery and reports

Server `PATCH` accepts `discoverable`, `discoveryMode` (`public`, `invite`, or `approval`), `discoveryCategory`, and up to ten `discoveryTags`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/discovery?q=&category=` | Up to 100 opted-in listings. |
| `POST` | `/api/servers/:id/join` | Public join or creates an approval request. |
| `GET` | `/api/servers/:id/membership-requests` | Server manager queue. |
| `POST` | `/api/servers/:id/membership-requests/:userId` | `{decision:"approved"|"declined"}`. |
| `POST` | `/api/reports` | `{reason,serverId?,messageId?}`. |

## Voice placeholders

No audio or voice connection exists in v1.

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/channels/:id/voice-attempt` | Logs aggregate demand and returns `{available:false,title:"Feature Under Construction!",message}`. |
| `POST` | `/api/dms/:id/call-attempt` | Same behavior for direct calls. |

Voice channel records can still be created, positioned, permissioned, renamed, and deleted.

## Platform administration

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/api/admin/stats` | User/server/message/storage/report and placeholder-demand counts. |
| `GET` | `/api/admin/servers?q=` | Every server, including counts. |
| `GET` | `/api/admin/users?q=` | Search up to 200 accounts. |
| `PATCH` | `/api/admin/users/:id/moderation` | `{action:"suspend"|"unsuspend"|"mute"|"unmute",reason,durationMinutes?}`. |
| `PATCH` | `/api/admin/users/:id/role` | Owner only; `{role:"user"|"admin"}`. |
| `GET` | `/api/admin/dms?userId=` | DM metadata for investigations; content is not returned. |
| `POST` | `/api/admin/dms/:id/open` | `{reason}` begins explicit audited access. |
| `POST` | `/api/admin/dms/:id/close` | Ends access. |
| `GET` | `/api/admin/logs?before=&limit=&serverId=&dmId=&event=` | Global logs. A DM filter requires active audited access. |
| `GET` | `/api/admin/logs/expiring?days=5` | Counts and groups records approaching deletion. |
| `POST` | `/api/admin/logs/export` | `{password,from?,to?,serverId?,dmId?}`. Returns and stores an AES-256-GCM `.bclog` archive. |
| `GET` | `/api/admin/notifications` | Log-retention warnings and other admin notices. |
| `POST` | `/api/admin/notifications/:id/read` | Mark read. |
| `GET` / `PATCH` | `/api/admin/reports` / `/api/admin/reports/:id` | Review queue and `{status}` updates. |
| `POST` | `/api/admin/maintenance` | Manually runs warnings, retention, session, and file cleanup. |
| `GET` | `/api/servers/:id/logs` | Server audit view for `VIEW_AUDIT_LOG`; never exposes other servers or DMs. |

Daily maintenance notifies every active global admin when records will expire within the configured five-day window. A `dedupe_key` guarantees one warning per administrator per day. Warnings never postpone deletion. Audit events are purged at their individual 30-day deadlines; message edit history, voice-attempt metrics, closed DM-access sessions, and deleted files follow the same retention boundary. Export files live in `BABCORD_EXPORT_DIR`, separate from normal snapshots.

Global log views and exports exclude DM-scoped records by default. Supplying `dmId` requires a currently open, reason-bearing access session for that exact conversation. This prevents the general audit screen or a broad export from silently bypassing the mandatory DM-opening workflow.

The `.bclog` binary format is: eight ASCII bytes `BABCORD1`, 16-byte scrypt salt, 12-byte AES-GCM IV, 16-byte authentication tag, then ciphertext. Cleartext is UTF-8 JSON with format name `babcord-audit-v1`. On the Windows host, open an export with `deployment\scripts\Open-BabcordLogExport.ps1 -InputFile <archive.bclog>`; it verifies the header and authentication tag, refuses to overwrite an existing output, and writes local JSON only after successful decryption.

## Realtime WebSocket

1. Call `POST /api/realtime-ticket` with the bearer token.
2. Connect to the returned `url` within 30 seconds. Tickets are random, one-use, and stored only in memory as hashes.
3. The same origin policy applies to the upgrade. Up to five sockets are allowed per account.

The server first sends:

```json
{"type":"hello","user":{},"onlineUserIds":[1,2],"serverTime":1785776400000}
```

Server-to-client event types include:

- `message.created`, `message.updated`, `message.deleted`
- `server.updated`, `server.deleted`
- `channel.created`, `channel.updated`, `channel.deleted`
- `member.joined`, `member.left`, `member.kicked`, `member.banned`
- `typing`, `presence.updated`, `account.moderated`
- `error`, `pong`, `subscribed.dm`

Client-to-server messages:

```json
{"type":"ping"}
{"type":"typing","channelId":4,"active":true}
{"type":"typing","dmId":9,"active":true}
{"type":"presence","status":"online"}
{"type":"subscribe.dm","dmId":9}
{"type":"unsubscribe.dm","dmId":9}
```

DM participants receive their own DM events automatically. A global admin only receives inspected-DM events after an audited `subscribe.dm`, and only while an explicit access session is active. The server pings sockets every 30 seconds and terminates dead connections.

## Default rate limits

- Registration: 30 per IP per hour by default (configurable for the deployment).
- Login: 10 per normalized username and 20 per IP per 15 minutes.
- Password recovery: 5 per IP per hour.
- Authenticated API: 120 requests per account per minute.
- Messages: 10 per account per 10 seconds.
- New DMs: 10 per account per hour.
- Uploads: 20 per account per hour.
- Invite creation: 20 per account per hour.
- Owned servers: 5 per ordinary account.
- WebSocket events: 40 per account per 10 seconds.

Rate limits are in-memory abuse controls and reset when the Babcord process restarts. Durable account/session/moderation state remains in SQLite.
