import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function integer(name, fallback, minimum = 0) {
  const value = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function loadConfig(overrides = {}) {
  const dataDir = resolve(overrides.dataDir ?? process.env.BABCORD_DATA_DIR ?? './data');
  const exportDir = resolve(overrides.exportDir ?? process.env.BABCORD_EXPORT_DIR ?? resolve(dataDir, 'exports'));
  const databasePath = resolve(overrides.databasePath ?? process.env.BABCORD_DATABASE_PATH ?? resolve(dataDir, 'babcord.sqlite3'));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(resolve(dataDir, 'attachments'), { recursive: true });
  mkdirSync(exportDir, { recursive: true });

  const secret = overrides.secret ?? process.env.BABCORD_SECRET ?? process.env.BABCORD_SESSION_SECRET;
  const recoverySecret = overrides.recoverySecret ?? process.env.BABCORD_RECOVERY_PEPPER ?? secret;
  return {
    host: overrides.host ?? process.env.BABCORD_HOST ?? '127.0.0.1',
    port: overrides.port ?? integer('BABCORD_PORT', 8080, 1),
    dataDir,
    databasePath,
    attachmentDir: resolve(dataDir, 'attachments'),
    exportDir,
    clientDir: resolve(overrides.clientDir ?? process.env.BABCORD_CLIENT_DIR ?? './client'),
    webOrigin: overrides.webOrigin ?? process.env.BABCORD_WEB_ORIGIN ?? 'https://babcord.withermask.net',
    publicUrl: overrides.publicUrl ?? process.env.BABCORD_PUBLIC_URL ?? 'https://babcord.withermask.net',
    secret: secret ?? randomBytes(32).toString('hex'),
    recoverySecret: recoverySecret ?? secret ?? randomBytes(32).toString('hex'),
    secretIsEphemeral: !secret && !overrides.secret,
    sessionDays: overrides.sessionDays ?? integer('BABCORD_SESSION_DAYS', 30, 1),
    registrationRateLimitPerHour: overrides.registrationRateLimitPerHour ?? integer('BABCORD_REGISTRATION_RATE_LIMIT_PER_HOUR', 30, 1),
    logRetentionDays: overrides.logRetentionDays ?? integer('BABCORD_LOG_RETENTION_DAYS', 30, 1),
    logWarningDays: overrides.logWarningDays ?? integer('BABCORD_LOG_WARNING_DAYS', 5, 1),
    logWarningHour: Math.min(23, overrides.logWarningHour ?? integer('BABCORD_LOG_WARNING_HOUR', 9, 0)),
    maxImageBytes: overrides.maxImageBytes ?? integer('BABCORD_MAX_IMAGE_BYTES', 5 * 1024 * 1024, 1),
    maxFileBytes: overrides.maxFileBytes ?? integer('BABCORD_MAX_FILE_BYTES', 10 * 1024 * 1024, 1),
    maxAttachmentsPerMessage: 4,
    adminUsername: overrides.adminUsername ?? process.env.BABCORD_ADMIN_USERNAME ?? process.env.BABCORD_BOOTSTRAP_ADMIN_USERNAME ?? null,
    adminPassword: overrides.adminPassword ?? process.env.BABCORD_ADMIN_PASSWORD ?? process.env.BABCORD_BOOTSTRAP_ADMIN_PASSWORD ?? null,
    clientVersion: overrides.clientVersion ?? process.env.BABCORD_CLIENT_VERSION ?? '1.0.0',
    minimumClientVersion: overrides.minimumClientVersion ?? process.env.BABCORD_MIN_CLIENT_VERSION ?? '1.0.0',
    clientBundleUrl: overrides.clientBundleUrl ?? process.env.BABCORD_CLIENT_BUNDLE_URL ?? '/client/app.js',
    clientStyleUrl: overrides.clientStyleUrl ?? process.env.BABCORD_CLIENT_STYLE_URL ?? '/client/app.css',
    clientDownloadUrl: overrides.clientDownloadUrl ?? process.env.BABCORD_CLIENT_DOWNLOAD_URL ?? null,
    testing: Boolean(overrides.testing),
  };
}
