# Babcord Windows server

This directory contains the complete Node.js 24 backend for the Windows-hosted Babcord v1. It uses Node's built-in SQLite binding plus `ws`; there is no cloud database and no provider request quota.

## First run

Install this directory's dependency, choose permanent secrets, and supply the initial owner credentials before the first start. In PowerShell:

```powershell
npm install
$env:BABCORD_DATA_DIR = 'D:\BabcordData'
$env:BABCORD_SECRET = '<at least 32 random bytes encoded as text>'
$env:BABCORD_RECOVERY_PEPPER = '<a different random secret>'
$env:BABCORD_ADMIN_USERNAME = 'YourUsername'
$env:BABCORD_ADMIN_PASSWORD = '<a long one-time bootstrap password>'
npm start
```

The owner is created once. Bootstrap credentials are ignored after an owner exists. Recovery codes are deliberately never printed to service logs; sign in with the bootstrap password and regenerate them in account settings. Do not rotate `BABCORD_RECOVERY_PEPPER` until all users have regenerated their recovery codes. Rotating `BABCORD_SECRET` revokes practical access to old session tokens.

The server refuses normal startup if `BABCORD_SECRET` is absent or if no owner exists. It binds only to `127.0.0.1:8080`, making it suitable behind the project Cloudflare Tunnel configuration.

## Configuration

| Variable | Default |
|---|---|
| `BABCORD_HOST` | `127.0.0.1` |
| `BABCORD_PORT` | `8080` |
| `BABCORD_DATA_DIR` | `./data` |
| `BABCORD_DATABASE_PATH` | `<data>/babcord.sqlite3` |
| `BABCORD_EXPORT_DIR` | `<data>/exports` |
| `BABCORD_CLIENT_DIR` | `./client` |
| `BABCORD_PUBLIC_URL` | `https://babcord.withermask.net` |
| `BABCORD_WEB_ORIGIN` | `https://babcord.withermask.net` |
| `BABCORD_SECRET` | required; session/IP-hash secret |
| `BABCORD_RECOVERY_PEPPER` | `BABCORD_SECRET`, but a separate value is strongly recommended |
| `BABCORD_ADMIN_USERNAME` | required on first run |
| `BABCORD_ADMIN_PASSWORD` | required on first run |
| `BABCORD_SESSION_DAYS` | `30` |
| `BABCORD_REGISTRATION_RATE_LIMIT_PER_HOUR` | `30` registrations per public IP (suitable for a shared school connection) |
| `BABCORD_LOG_RETENTION_DAYS` | `30` |
| `BABCORD_LOG_WARNING_DAYS` | `5` |
| `BABCORD_LOG_WARNING_HOUR` | `9` (local machine hour, 0–23; `09:00` is also parsed as 9) |
| `BABCORD_MAX_IMAGE_BYTES` | `5242880` |
| `BABCORD_MAX_FILE_BYTES` | `10485760` |
| `BABCORD_CLIENT_VERSION` | `1.0.0` |
| `BABCORD_MIN_CLIENT_VERSION` | `1.0.0` |

Compatibility aliases are accepted for deployment migrations: `BABCORD_SESSION_SECRET` when `BABCORD_SECRET` is absent, and `BABCORD_BOOTSTRAP_ADMIN_USERNAME` / `BABCORD_BOOTSTRAP_ADMIN_PASSWORD` when the canonical admin variables are absent. Canonical names take precedence.

`BABCORD_EXPORT_DIR` holds encrypted, manually requested audit exports. Keep routine database and attachment snapshots in a different location. Never sync the live SQLite files with OneDrive; snapshot the database using the deployment backup workflow.

## Operations

- `npm start` starts the localhost service.
- `npm test` runs isolated API integration tests.
- `GET /health` is the tunnel/service health check.
- `SIGINT` and `SIGTERM` stop WebSockets, HTTP, and SQLite cleanly. A Windows service wrapper should restart unexpected failures.
- SQLite uses WAL mode and foreign-key enforcement. Schema creation is idempotent; the `schema_migrations` table and `migrations/` support upgrades.
- Maintenance runs on startup and hourly. It creates at most one five-day expiration warning per administrator per day and purges each record only at its own deadline.

See [API.md](./API.md) for the full REST, realtime, retention, permission, and file contract.
