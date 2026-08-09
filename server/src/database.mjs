import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS } from './permissions.mjs';
import { generateRecoveryCodes, hashPassword, normalizeUsername, recoveryHash } from './security.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(here, '..', 'schema.sql'), 'utf8');
const attachmentPurposeMigration = readFileSync(resolve(here, '..', 'migrations', '002_attachment-purpose.sql'), 'utf8');
const messageMentionsMigration = readFileSync(resolve(here, '..', 'migrations', '003_message-mentions.sql'), 'utf8');
const channelTopicsMigration = readFileSync(resolve(here, '..', 'migrations', '004_channel-topics.sql'), 'utf8');
const adminDmSessionMigration = readFileSync(resolve(here, '..', 'migrations', '005-admin-dm-session.sql'), 'utf8');

export function now() {
  return Date.now();
}

export function asId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function createDatabase(config) {
  const db = new DatabaseSync(config.databasePath, { enableForeignKeyConstraints: true });
  db.exec(schema);
  db.exec('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (1,' + now() + ')');
  const attachmentColumns = db.prepare('PRAGMA table_info(attachments)').all().map((column) => column.name);
  if (!attachmentColumns.includes('purpose')) db.exec(attachmentPurposeMigration);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(2, now());
  db.exec(messageMentionsMigration);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(3, now());
  const channelColumns = db.prepare('PRAGMA table_info(channels)').all().map((column) => column.name);
  if (!channelColumns.includes('topic')) db.exec(channelTopicsMigration);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(4, now());
  const adminDmAccessColumns = db.prepare('PRAGMA table_info(admin_dm_access)').all().map((column) => column.name);
  if (!adminDmAccessColumns.includes('session_id')) db.exec(adminDmSessionMigration);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_dm_access_session_active
    ON admin_dm_access(admin_id,session_id,dm_id,closed_at,last_access_at)`);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(5, now());
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function systemServer(db) {
  return db.prepare('SELECT * FROM servers WHERE is_system=1').get();
}

export async function seedDatabase(db, config) {
  const time = now();
  let owner = db.prepare("SELECT * FROM users WHERE global_role='owner' AND status!='deleted' LIMIT 1").get();
  let recoveryCodes = null;
  if (!owner && config.adminUsername && config.adminPassword) {
    const username = String(config.adminUsername).trim();
    const password = await hashPassword(config.adminPassword);
    const result = db.prepare(`INSERT INTO users(username,username_norm,display_name,password_hash,password_salt,global_role,created_at)
      VALUES (?,?,?,?,?,'owner',?)`).run(username, normalizeUsername(username), username, password.hash, password.salt, time);
    const ownerId = Number(result.lastInsertRowid);
    recoveryCodes = generateRecoveryCodes();
    const insertCode = db.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)');
    for (const code of recoveryCodes) insertCode.run(ownerId, recoveryHash(code, config.recoverySecret), time);
    owner = db.prepare('SELECT * FROM users WHERE id=?').get(ownerId);
  }

  let mandatory = systemServer(db);
  if (!mandatory) {
    const serverResult = db.prepare(`INSERT INTO servers(name,description,owner_id,is_system,discoverable,discovery_mode,created_at)
      VALUES ('Babcock','The mandatory community for every Babcord account.',?,1,0,'public',?)`).run(owner?.id ?? null, time);
    const serverId = Number(serverResult.lastInsertRowid);
    db.prepare('INSERT INTO roles(server_id,name,color,position,is_default,permissions,created_at) VALUES (?,?,?,?,1,?,?)')
      .run(serverId, '@everyone', '#99aab5', 0, DEFAULT_PERMISSIONS, time);
    db.prepare("INSERT INTO channels(server_id,name,type,position,created_at) VALUES (?,'Information','category',0,?)").run(serverId, time);
    const categoryId = Number(db.prepare("SELECT id FROM channels WHERE server_id=? AND type='category' ORDER BY id LIMIT 1").get(serverId).id);
    db.prepare("INSERT INTO channels(server_id,parent_id,name,type,position,created_at) VALUES (?,?,'general','text',0,?)")
      .run(serverId, categoryId, time);
    mandatory = systemServer(db);
  } else if (!mandatory.owner_id && owner) {
    db.prepare('UPDATE servers SET owner_id=? WHERE id=?').run(owner.id, mandatory.id);
  }

  // Mandatory membership is repaired at every startup.
  db.prepare(`INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at)
    SELECT ?,id,? FROM users WHERE status!='deleted'`).run(mandatory.id, time);

  if (owner) {
    db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(mandatory.id, owner.id, time);
    let adminRole = db.prepare("SELECT id FROM roles WHERE server_id=? AND name='Platform Administration'").get(mandatory.id);
    if (!adminRole) {
      const roleResult = db.prepare('INSERT INTO roles(server_id,name,color,position,permissions,created_at) VALUES (?,?,?,?,?,?)')
        .run(mandatory.id, 'Platform Administration', '#ed4245', 1000, ALL_PERMISSIONS, time);
      adminRole = { id: Number(roleResult.lastInsertRowid) };
    }
    db.prepare('INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id,assigned_at) VALUES (?,?,?,?)')
      .run(mandatory.id, owner.id, adminRole.id, time);
  }

  return { owner, mandatory, recoveryCodes };
}

export function audit(db, config, eventType, details = {}) {
  const created = now();
  const payload = JSON.stringify(details.payload ?? {});
  const result = db.prepare(`INSERT INTO audit_logs
    (event_type,actor_id,server_id,dm_id,message_id,target_type,target_id,reason,payload,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventType,
      details.actorId ?? null,
      details.serverId ?? null,
      details.dmId ?? null,
      details.messageId ?? null,
      details.targetType ?? null,
      details.targetId ?? null,
      details.reason ?? null,
      payload,
      created,
      created + config.logRetentionDays * 86_400_000,
    );
  return Number(result.lastInsertRowid);
}

export function isGlobalAdmin(user) {
  return user && (user.global_role === 'admin' || user.global_role === 'owner');
}

export function serverPermissions(db, user, serverId, channelId = null) {
  if (isGlobalAdmin(user)) return ALL_PERMISSIONS;
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!server) return 0;
  if (Number(server.owner_id) === Number(user.id)) return ALL_PERMISSIONS;
  const member = db.prepare('SELECT * FROM server_members WHERE server_id=? AND user_id=?').get(serverId, user.id);
  if (!member) return 0;
  let bits = 0;
  const roles = db.prepare(`SELECT r.* FROM roles r
    LEFT JOIN member_roles mr ON mr.role_id=r.id AND mr.user_id=?
    WHERE r.server_id=? AND (r.is_default=1 OR mr.user_id IS NOT NULL)`).all(user.id, serverId);
  for (const role of roles) bits |= Number(role.permissions);
  if (bits & 4096) return ALL_PERMISSIONS;
  if (channelId) {
    const defaultRole = roles.find((role) => role.is_default === 1);
    const overrides = db.prepare('SELECT * FROM channel_overrides WHERE channel_id=?').all(channelId);
    const defaultOverride = overrides.find((item) => item.target_type === 'role' && item.target_id === defaultRole?.id);
    if (defaultOverride) bits = (bits & ~Number(defaultOverride.deny_bits)) | Number(defaultOverride.allow_bits);

    const assignedRoleIds = new Set(roles.filter((role) => !role.is_default).map((role) => Number(role.id)));
    let roleDeny = 0;
    let roleAllow = 0;
    for (const override of overrides) {
      if (override.target_type === 'role' && assignedRoleIds.has(Number(override.target_id))) {
        roleDeny |= Number(override.deny_bits);
        roleAllow |= Number(override.allow_bits);
      }
    }
    bits = (bits & ~roleDeny) | roleAllow;

    const memberOverride = overrides.find((item) => item.target_type === 'member' && Number(item.target_id) === Number(user.id));
    if (memberOverride) bits = (bits & ~Number(memberOverride.deny_bits)) | Number(memberOverride.allow_bits);
  }
  return bits;
}

export function serializeServer(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    iconUrl: row.icon_path ? `/api/servers/${row.id}/icon` : null,
    ownerId: row.owner_id,
    mandatory: Boolean(row.is_system),
    discoverable: Boolean(row.discoverable),
    discoveryMode: row.discovery_mode,
    discoveryCategory: row.discovery_category,
    discoveryTags: json(row.discovery_tags, []),
    createdAt: row.created_at,
  };
}

export function serializeChannel(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    parentId: row.parent_id,
    name: row.name,
    topic: row.topic ?? '',
    type: row.type,
    position: row.position,
    userLimit: row.user_limit,
    createdAt: row.created_at,
  };
}
