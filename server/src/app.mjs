import http from 'node:http';
import { createCipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { audit, asId, createDatabase, isGlobalAdmin, json, now, seedDatabase, serializeChannel, serializeServer, serverPermissions, systemServer, transaction } from './database.mjs';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, hasBit, Permissions } from './permissions.mjs';
import { generateRecoveryCodes, hashIp, hashPassword, normalizeUsername, publicUser, randomToken, recoveryHash, tokenHash, validatePassword, validateUsername, verifyPassword } from './security.mjs';
import { boolean, boundedInteger, clientIp, contentDisposition, HttpError, RateLimiter, readBuffer, readJson, requireText, optionalText, Router, sendEmpty, sendJson, serveFile } from './http-utils.mjs';

const MESSAGE_SELECT = `SELECT m.*,u.username,u.display_name,u.avatar_path,
  (SELECT json_group_array(json_object('id',a.id,'name',a.original_name,'contentType',a.content_type,'size',a.size,'url','/api/attachments/'||a.id)) FROM attachments a WHERE a.message_id=m.id) attachments,
  (SELECT json_group_array(json_object('emoji',emoji,'count',count)) FROM (SELECT emoji,COUNT(*) count FROM reactions WHERE message_id=m.id GROUP BY emoji)) reactions,
  (SELECT json_group_array(json_object('id',mu.id,'username',mu.username,'displayName',mu.display_name)) FROM
    (SELECT mentioned.id,mentioned.username,mentioned.display_name FROM message_mentions mm JOIN users mentioned ON mentioned.id=mm.user_id WHERE mm.message_id=m.id) mu) mentions,
  (SELECT json_object('id',reply.id,'content',CASE WHEN reply.deleted_at IS NULL THEN reply.content ELSE NULL END,
    'deleted',CASE WHEN reply.deleted_at IS NULL THEN 0 ELSE 1 END,'author',json_object('id',CASE WHEN reply.administration=1 THEN NULL ELSE reply.author_id END,
    'username',CASE WHEN reply.administration=1 THEN 'Administration' ELSE reply_user.username END,
    'displayName',CASE WHEN reply.administration=1 THEN 'Administration' ELSE reply_user.display_name END))
    FROM messages reply JOIN users reply_user ON reply_user.id=reply.author_id WHERE reply.id=m.reply_to_id) reply_to
  FROM messages m JOIN users u ON u.id=m.author_id`;

const MAX_AUDIT_EXPORT_RECORDS = 10_000;
const INDEFINITE_MUTE_UNTIL = 253_402_300_799_999;

function serializeMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    dmId: row.dm_id,
    content: row.deleted_at ? null : row.content,
    deleted: Boolean(row.deleted_at),
    deletedAt: row.deleted_at,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
    administration: Boolean(row.administration),
    isAdministrative: Boolean(row.administration),
    authorType: row.administration ? 'administration' : 'user',
    visibleAs: row.administration ? 'Administration' : null,
    author: row.administration ? {
      id: null,
      username: 'Administration',
      displayName: 'Administration',
      avatarUrl: null,
      official: true,
    } : {
      id: row.author_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_path ? `/api/users/${row.author_id}/avatar` : null,
    },
    attachments: row.deleted_at ? [] : json(row.attachments, []),
    reactions: json(row.reactions, []),
    mentions: row.deleted_at ? [] : json(row.mentions, []),
    replyTo: row.reply_to ? json(row.reply_to, null) : null,
  };
}

function serializeAudit(row) {
  return {
    ...row,
    payload: json(row.payload),
    action: row.event_type,
    type: row.event_type,
    actorId: row.actor_id,
    actorName: row.actor_display_name ?? row.actor_username ?? null,
    serverId: row.server_id,
    dmId: row.dm_id,
    messageId: row.message_id,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function serializeRole(row) {
  return { id: row.id, serverId: row.server_id, name: row.name, color: row.color, position: row.position, default: Boolean(row.is_default), permissions: row.permissions };
}

function cleanName(value, label = 'Name', max = 100) {
  const result = requireText(value, label, 1, max).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!result) throw new HttpError(400, 'INVALID_FIELD', `${label} cannot be empty.`);
  return result;
}

function roleColor(value, fallback = '#99aab5') {
  const color = value ?? fallback;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'INVALID_COLOR', 'Role color must be a six-digit hex color such as #5865f2.');
  return color.toLowerCase();
}

function pageLimit(url, max = 100) {
  return boundedInteger(url.searchParams.get('limit'), 'limit', 1, max, 50);
}

function isImageType(type) {
  return /^image\/(png|jpeg|gif|webp)$/i.test(type);
}

export async function createBabcordServer(config) {
  const db = createDatabase(config);
  const seed = await seedDatabase(db, config);
  const router = new Router();
  const limiter = new RateLimiter();
  const realtimeTickets = new Map();
  const sockets = new Set();
  let maintenanceTimer = null;
  const startedAt = new Date().toISOString();

  function originAllowed(origin) {
    if (!origin) return true;
    if (origin === 'null') return true;
    return origin.replace(/\/$/, '') === config.webOrigin.replace(/\/$/, '');
  }

  function corsHeaders(request) {
    const origin = request.headers.origin;
    if (!origin || !originAllowed(origin)) return { Vary: 'Origin' };
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Babcord-Client-Version, X-File-Name',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Babcord-Client-Version',
      'X-Babcord-Client-Version': config.clientVersion,
      Vary: 'Origin',
    };
  }

  function getSession(request) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return null;
    const hash = tokenHash(authorization.slice(7));
    const row = db.prepare(`SELECT s.id session_id,s.expires_at,s.last_seen_at,u.* FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(hash, now());
    if (!row || row.status !== 'active') return null;
    if (row.last_seen_at < now() - 300_000) db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), row.session_id);
    return row;
  }

  function requireAdmin(user) {
    if (!isGlobalAdmin(user)) throw new HttpError(403, 'ADMIN_REQUIRED', 'A platform administrator account is required.');
  }

  function requirePermission(user, serverId, permission, channelId = null) {
    const server = getServer(serverId);
    if (server.is_system && !isGlobalAdmin(user) && ![Permissions.VIEW_CHANNEL, Permissions.SEND_MESSAGES].includes(permission)) {
      throw new HttpError(403, 'PROTECTED_SERVER', 'Only platform administrators can manage the mandatory Babcock server.');
    }
    if (!hasBit(serverPermissions(db, user, serverId, channelId), permission)) {
      throw new HttpError(403, 'MISSING_PERMISSION', 'You do not have permission to do that.');
    }
  }

  function bypassesRoleHierarchy(user, serverId) {
    return isGlobalAdmin(user) || Number(getServer(serverId).owner_id) === Number(user.id);
  }

  function highestRolePosition(serverId, userId) {
    const row = db.prepare(`SELECT COALESCE(MAX(r.position),0) position FROM roles r
      WHERE r.server_id=? AND (r.is_default=1 OR EXISTS (
        SELECT 1 FROM member_roles mr WHERE mr.server_id=? AND mr.user_id=? AND mr.role_id=r.id
      ))`).get(serverId, serverId, userId);
    return Number(row?.position ?? 0);
  }

  function requireRoleBelowActor(user, serverId, rolePosition) {
    if (bypassesRoleHierarchy(user, serverId)) return;
    if (Number(rolePosition) >= highestRolePosition(serverId, user.id)) {
      throw new HttpError(403, 'ROLE_HIERARCHY', 'You can only manage roles below your highest role.');
    }
  }

  function requireMemberBelowActor(user, serverId, targetId) {
    const targetUser = db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
    if (isGlobalAdmin(targetUser) && !isGlobalAdmin(user)) throw new HttpError(409, 'PROTECTED_MEMBER', 'Platform administrators are protected from server role and moderation actions.');
    const server = getServer(serverId);
    if (Number(targetId) === Number(server.owner_id) && Number(targetId) !== Number(user.id) && !isGlobalAdmin(user)) {
      throw new HttpError(409, 'PROTECTED_MEMBER', 'The server owner is protected from delegated actions.');
    }
    if (bypassesRoleHierarchy(user, serverId)) return;
    if (!db.prepare('SELECT 1 FROM server_members WHERE server_id=? AND user_id=?').get(serverId, targetId)) return;
    if (highestRolePosition(serverId, targetId) >= highestRolePosition(serverId, user.id)) {
      throw new HttpError(403, 'ROLE_HIERARCHY', 'You can only manage members below your highest role.');
    }
  }

  async function moderationOwnerSuccessor(server, user, targetId, targetUser, body) {
    if (Number(targetId) !== Number(server.owner_id)) return null;
    if (!isGlobalAdmin(user)) throw new HttpError(409, 'PROTECTED_MEMBER', 'Only a platform administrator can moderate a server owner.');
    if (targetUser?.global_role === 'owner') throw new HttpError(409, 'PROTECTED_MEMBER', 'The platform owner cannot be removed from a server.');
    const successorId = asId(body.transferToUserId);
    const successor = successorId && successorId !== targetId ? db.prepare(`SELECT u.* FROM server_members m
      JOIN users u ON u.id=m.user_id WHERE m.server_id=? AND m.user_id=? AND u.status='active'`).get(server.id, successorId) : null;
    if (!successor) throw new HttpError(409, 'TRANSFER_REQUIRED', 'Choose another active current member to receive server ownership first.');
    if (body.confirmName !== server.name) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact current server name to confirm owner moderation.');
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    return successor;
  }

  function assertActiveForMessaging(user) {
    if (user.status === 'suspended') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    if (user.muted_until && user.muted_until > now()) throw new HttpError(403, 'PLATFORM_MUTED', 'This account is temporarily muted.');
  }

  function assertParticipationAllowed(user, serverId = null) {
    assertActiveForMessaging(user);
    if (!serverId || isGlobalAdmin(user)) return;
    const activeBan = db.prepare(`SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?
      AND (expires_at IS NULL OR expires_at>?)`).get(serverId, user.id, now());
    if (activeBan) throw new HttpError(403, 'BANNED', 'You are banned from this server.');
    const membership = db.prepare('SELECT muted_until FROM server_members WHERE server_id=? AND user_id=?').get(serverId, user.id);
    if (membership?.muted_until && membership.muted_until > now()) {
      throw new HttpError(403, 'SERVER_MUTED', 'You are temporarily muted in this server.');
    }
  }

  function issueSession(userId, request) {
    const token = randomToken();
    const created = now();
    db.prepare(`INSERT INTO sessions(user_id,token_hash,created_at,last_seen_at,expires_at,user_agent,ip_hash)
      VALUES (?,?,?,?,?,?,?)`).run(userId, tokenHash(token), created, created, created + config.sessionDays * 86_400_000,
      String(request.headers['user-agent'] ?? '').slice(0, 300), hashIp(clientIp(request), config.secret));
    const active = db.prepare('SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC').all(userId);
    for (const old of active.slice(10)) db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(), old.id);
    return token;
  }

  function getChannel(channelId) {
    const channel = db.prepare('SELECT * FROM channels WHERE id=?').get(channelId);
    if (!channel) throw new HttpError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');
    return channel;
  }

  function getServer(serverId) {
    const server = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
    if (!server) throw new HttpError(404, 'SERVER_NOT_FOUND', 'Server not found.');
    return server;
  }

  function retainMessagesBeforeContainerDeletion(channelIds, actorId, serverId, reason) {
    if (!channelIds.length) return 0;
    const placeholders = channelIds.map(() => '?').join(',');
    const messages = db.prepare(`SELECT * FROM messages WHERE channel_id IN (${placeholders}) AND deleted_at IS NULL`).all(...channelIds);
    const findAttachments = db.prepare('SELECT id,original_name,content_type,size FROM attachments WHERE message_id=?');
    const markAttachments = db.prepare('UPDATE attachments SET deleted_at=? WHERE message_id=?');
    const deletionTime = now();
    for (const message of messages) {
      const attachments = findAttachments.all(message.id);
      markAttachments.run(deletionTime, message.id);
      audit(db, config, 'message.deleted', {
        actorId,
        serverId,
        messageId: message.id,
        targetType: 'message',
        targetId: message.id,
        reason,
        payload: {
          originalContent: message.content,
          attachments,
          originalAuthorId: message.author_id,
          deletedAt: deletionTime,
          containerDeleted: true,
        },
      });
    }
    return messages.length;
  }

  function performServerDeletion(server, user, reason) {
    if (server.is_system) throw new HttpError(409, 'PROTECTED_SERVER', 'The mandatory Babcock server cannot be deleted.');
    if (Number(server.owner_id) !== Number(user.id) && !isGlobalAdmin(user)) throw new HttpError(403, 'OWNER_REQUIRED', 'Only the server owner or a platform administrator can delete this server.');
    const channelIds = db.prepare('SELECT id FROM channels WHERE server_id=?').all(server.id).map((row) => row.id);
    const memberIds = db.prepare('SELECT user_id FROM server_members WHERE server_id=?').all(server.id).map((row) => row.user_id);
    transaction(db, () => {
      const retainedMessages = retainMessagesBeforeContainerDeletion(channelIds, user.id, server.id, reason ?? 'Server deleted');
      audit(db, config, 'server.deleted', { actorId: user.id, serverId: server.id, targetType: 'server', targetId: server.id, reason, payload: { name: server.name, retainedMessages } });
      if (server.icon_path) db.prepare("UPDATE attachments SET deleted_at=? WHERE stored_name=? AND purpose='server_icon'").run(now(), server.icon_path);
      db.prepare(`UPDATE attachments SET deleted_at=? WHERE message_id IN
        (SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.server_id=?)`).run(now(), server.id);
      db.prepare('DELETE FROM servers WHERE id=?').run(server.id);
    });
    broadcastUsers(memberIds, { type: 'server.deleted', serverId: server.id });
  }

  function dmAccess(user, dmId, forAdmin = false) {
    const dm = db.prepare('SELECT * FROM dm_conversations WHERE id=?').get(dmId);
    if (!dm) throw new HttpError(404, 'DM_NOT_FOUND', 'Direct-message conversation not found.');
    const participant = db.prepare('SELECT * FROM dm_participants WHERE dm_id=? AND user_id=?').get(dmId, user.id);
    if (participant) return { dm, participant, admin: false };
    if (isGlobalAdmin(user)) {
      const access = db.prepare(`SELECT * FROM admin_dm_access WHERE dm_id=? AND admin_id=? AND session_id=?
        AND closed_at IS NULL AND last_access_at>? ORDER BY opened_at DESC LIMIT 1`)
        .get(dmId, user.id, user.session_id, now() - 3_600_000);
      if (access) return { dm, access, admin: true };
      if (forAdmin) throw new HttpError(403, 'DM_ACCESS_REQUIRED', 'Open an audited administration session before accessing this DM.');
    }
    throw new HttpError(403, 'DM_ACCESS_DENIED', 'You do not have access to this DM.');
  }

  function dmIsDeclined(dmId) {
    return Boolean(db.prepare("SELECT 1 FROM dm_participants WHERE dm_id=? AND request_state='declined' LIMIT 1").get(dmId));
  }

  function sendTo(socket, event) {
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  }

  function broadcastUsers(userIds, event) {
    const allowed = new Set(userIds.map(Number));
    for (const socket of sockets) if (allowed.has(Number(socket.user.id))) sendTo(socket, event);
  }

  function broadcastServer(serverId, event) {
    const ids = db.prepare('SELECT user_id FROM server_members WHERE server_id=?').all(serverId).map((row) => row.user_id);
    broadcastUsers(ids, event);
  }

  function visibleChannelSockets(serverId, channelId) {
    return [...sockets].filter((socket) => hasBit(
      serverPermissions(db, socket.user, serverId, channelId),
      Permissions.VIEW_CHANNEL,
    ));
  }

  function broadcastSockets(recipients, event) {
    for (const socket of recipients) sendTo(socket, event);
  }

  function broadcastChannel(serverId, channelId, event) {
    broadcastSockets(visibleChannelSockets(serverId, channelId), event);
  }

  function broadcastDm(dmId, event) {
    const ids = db.prepare('SELECT user_id FROM dm_participants WHERE dm_id=?').all(dmId).map((row) => row.user_id);
    for (const socket of sockets) {
      const activeAdminAccess = socket.dmSubscriptions.has(dmId) && isGlobalAdmin(socket.user) && db.prepare(`
        SELECT 1 FROM admin_dm_access a JOIN sessions s ON s.id=a.session_id
        WHERE a.dm_id=? AND a.admin_id=? AND a.session_id=? AND a.closed_at IS NULL AND a.last_access_at>?
          AND s.revoked_at IS NULL AND s.expires_at>?`)
        .get(dmId, socket.user.id, socket.user.session_id, now() - 3_600_000, now());
      if (ids.includes(socket.user.id) || activeAdminAccess) sendTo(socket, event);
    }
  }

  router.add('GET', '/health', async ({ response }) => {
    sendJson(response, 200, { status: 'online', serverTime: new Date().toISOString(), version: config.clientVersion, minimumClientVersion: config.minimumClientVersion });
  });

  router.add('GET', '/client/manifest.json', async ({ response }) => {
    const assets = [config.clientBundleUrl, config.clientStyleUrl].map((assetUrl) => {
      const filename = assetUrl.split('/').pop();
      const path = resolve(config.clientDir, filename);
      return { url: assetUrl, sha256: existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('base64') : null };
    });
    sendJson(response, 200, {
      name: 'Babcord',
      version: config.clientVersion,
      minimumVersion: config.minimumClientVersion,
      apiBase: config.publicUrl,
      realtimeUrl: config.publicUrl.replace(/^http/, 'ws') + '/realtime',
      entry: '/client/index.html',
      downloadUrl: config.clientDownloadUrl || `${config.publicUrl}/client/Open%20Babcord.html`,
      javascript: config.clientBundleUrl,
      stylesheet: config.clientStyleUrl,
      assets,
      publishedAt: startedAt,
    }, { 'Cache-Control': 'no-cache' });
  });

  router.add('POST', '/api/auth/register', async ({ request, response, body }) => {
    limiter.check('register', clientIp(request), config.registrationRateLimitPerHour, 3_600_000);
    const usernameError = validateUsername(body.username);
    if (usernameError) throw new HttpError(400, 'INVALID_USERNAME', usernameError);
    const passwordError = validatePassword(body.password);
    if (passwordError) throw new HttpError(400, 'INVALID_PASSWORD', passwordError);
    const username = String(body.username).normalize('NFKC').trim();
    const displayName = body.displayName ? cleanName(body.displayName, 'Display name', 50) : username;
    const password = await hashPassword(body.password);
    const recoveryCodes = generateRecoveryCodes();
    const created = now();
    let userId;
    try {
      userId = transaction(db, () => {
        const result = db.prepare(`INSERT INTO users(username,username_norm,display_name,password_hash,password_salt,created_at)
          VALUES (?,?,?,?,?,?)`).run(username, normalizeUsername(username), displayName, password.hash, password.salt, created);
        const id = Number(result.lastInsertRowid);
        const insertCode = db.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)');
        for (const code of recoveryCodes) insertCode.run(id, recoveryHash(code, config.recoverySecret), created);
        const mandatory = systemServer(db);
        db.prepare('INSERT INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(mandatory.id, id, created);
        return id;
      });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'USERNAME_TAKEN', 'That username is already in use.');
      throw error;
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const token = issueSession(userId, request);
    audit(db, config, 'account.created', { actorId: userId, targetType: 'user', targetId: userId });
    sendJson(response, 201, { user: publicUser(user), token, recoveryCodes });
  });

  router.add('POST', '/api/auth/login', async ({ request, response, body }) => {
    const normalized = normalizeUsername(body.username);
    limiter.check('login-ip', clientIp(request), 20, 900_000);
    limiter.check('login-name', normalized, 10, 900_000);
    const user = db.prepare('SELECT * FROM users WHERE username_norm=?').get(normalized);
    if (!user || !(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) {
      throw new HttpError(401, 'INVALID_LOGIN', 'The username or password is incorrect.');
    }
    if (user.status === 'suspended') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    if (user.status === 'deleted') throw new HttpError(401, 'INVALID_LOGIN', 'The username or password is incorrect.');
    const token = issueSession(user.id, request);
    audit(db, config, 'account.login', { actorId: user.id, targetType: 'user', targetId: user.id });
    sendJson(response, 200, { user: publicUser(user), token });
  });

  router.add('POST', '/api/auth/recover', async ({ request, response, body }) => {
    limiter.check('recover-ip', clientIp(request), 5, 3_600_000);
    const passwordError = validatePassword(body.newPassword);
    if (passwordError) throw new HttpError(400, 'INVALID_PASSWORD', passwordError);
    const user = db.prepare("SELECT * FROM users WHERE username_norm=? AND status!='deleted'").get(normalizeUsername(body.username));
    if (!user) throw new HttpError(401, 'INVALID_RECOVERY', 'The username or recovery code is invalid.');
    if (user.status === 'suspended') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    const code = db.prepare('SELECT * FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(user.id, recoveryHash(body.recoveryCode, config.recoverySecret));
    if (!code) throw new HttpError(401, 'INVALID_RECOVERY', 'The username or recovery code is invalid.');
    const password = await hashPassword(body.newPassword);
    transaction(db, () => {
      db.prepare('UPDATE recovery_codes SET used_at=? WHERE id=?').run(now(), code.id);
      db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(password.hash, password.salt, user.id);
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(), user.id);
    });
    audit(db, config, 'account.recovered', { actorId: user.id, targetType: 'user', targetId: user.id });
    const token = issueSession(user.id, request);
    sendJson(response, 200, { user: publicUser(user), token });
  });

  router.add('POST', '/api/auth/logout', async ({ request, response, user }) => {
    db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE session_id=? AND closed_at IS NULL').run(now(), user.session_id);
    db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(), user.session_id);
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/me', async ({ response, user }) => {
    const servers = db.prepare(`SELECT s.* FROM servers s JOIN server_members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.is_system DESC,s.name`).all(user.id).map(serializeServer);
    sendJson(response, 200, { user: publicUser(user), servers });
  }, { auth: true });

  router.add('PATCH', '/api/me', async ({ response, user, body }) => {
    const displayName = body.displayName === undefined ? user.display_name : cleanName(body.displayName, 'Display name', 50);
    db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, user.id);
    audit(db, config, 'account.profile_updated', { actorId: user.id, targetType: 'user', targetId: user.id });
    sendJson(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
  }, { auth: true });

  router.add('GET', '/api/me/sessions', async ({ response, user }) => {
    const sessions = db.prepare(`SELECT id,created_at,last_seen_at,expires_at,user_agent,CASE WHEN id=? THEN 1 ELSE 0 END current
      FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC`).all(user.session_id, user.id, now())
      .map((session) => ({ ...session, createdAt: session.created_at, lastActiveAt: session.last_seen_at, expiresAt: session.expires_at, userAgent: session.user_agent, current: Boolean(session.current) }));
    sendJson(response, 200, { sessions });
  }, { auth: true });

  router.add('DELETE', '/api/me/sessions/:id', async ({ response, user, params }) => {
    const id = asId(params.id);
    db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE session_id=? AND admin_id=? AND closed_at IS NULL').run(now(), id, user.id);
    const result = db.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(now(), id, user.id);
    if (!result.changes) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/me/password', async ({ response, user, body }) => {
    if (!(await verifyPassword(String(body.currentPassword ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Current password is incorrect.');
    const error = validatePassword(body.newPassword);
    if (error) throw new HttpError(400, 'INVALID_PASSWORD', error);
    const password = await hashPassword(body.newPassword);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(password.hash, password.salt, user.id);
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND id!=? AND revoked_at IS NULL').run(now(), user.id, user.session_id);
    });
    audit(db, config, 'account.password_changed', { actorId: user.id, targetType: 'user', targetId: user.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/me/recovery-codes', async ({ response, user, body }) => {
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    const codes = generateRecoveryCodes();
    transaction(db, () => {
      db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(user.id);
      const insert = db.prepare('INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)');
      for (const code of codes) insert.run(user.id, recoveryHash(code, config.recoverySecret), now());
    });
    audit(db, config, 'account.recovery_codes_regenerated', { actorId: user.id, targetType: 'user', targetId: user.id });
    sendJson(response, 200, { recoveryCodes: codes });
  }, { auth: true });

  router.add('DELETE', '/api/me', async ({ response, user, body }) => {
    if (user.global_role === 'owner') throw new HttpError(409, 'OWNER_ACCOUNT', 'Transfer platform ownership before deleting this account.');
    if (db.prepare('SELECT 1 FROM servers WHERE owner_id=? AND is_system=0 LIMIT 1').get(user.id)) throw new HttpError(409, 'TRANSFER_REQUIRED', 'Transfer ownership or delete your servers before deleting this account.');
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    const timestamp = now();
    transaction(db, () => {
      if (user.avatar_path) db.prepare("UPDATE attachments SET deleted_at=? WHERE stored_name=? AND purpose='avatar'").run(timestamp, user.avatar_path);
      db.prepare("UPDATE users SET username=?,username_norm=?,display_name='Deleted User',password_hash=?,password_salt=?,status='deleted',avatar_path=NULL,deleted_at=? WHERE id=?")
        .run(`deleted-${user.id}`, `deleted-${user.id}`, randomToken(), randomToken(), timestamp, user.id);
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(timestamp, user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM dm_blocks WHERE blocker_id=? OR blocked_id=?').run(user.id, user.id);
      db.prepare('DELETE FROM server_members WHERE user_id=?').run(user.id);
      audit(db, config, 'account.deleted', { actorId: user.id, targetType: 'user', targetId: user.id });
    });
    sendEmpty(response);
  }, { auth: true });

  // Servers, channels, roles, invitations, and moderation.
  router.add('GET', '/api/servers', async ({ response, user }) => {
    const rows = db.prepare(`SELECT s.* FROM servers s JOIN server_members m ON m.server_id=s.id
      WHERE m.user_id=? ORDER BY s.is_system DESC,lower(s.name)`).all(user.id);
    sendJson(response, 200, { servers: rows.map(serializeServer) });
  }, { auth: true });

  router.add('POST', '/api/servers', async ({ request, response, user, body }) => {
    limiter.check('server-create', user.id, 5, 86_400_000);
    const owned = db.prepare('SELECT COUNT(*) count FROM servers WHERE owner_id=? AND is_system=0').get(user.id).count;
    if (owned >= 5 && !isGlobalAdmin(user)) throw new HttpError(409, 'SERVER_LIMIT', 'This account already owns the maximum of five servers.');
    const name = cleanName(body.name, 'Server name', 100);
    const created = now();
    const serverId = transaction(db, () => {
      const result = db.prepare('INSERT INTO servers(name,description,owner_id,created_at) VALUES (?,?,?,?)')
        .run(name, optionalText(body.description, 'Description', 1000) ?? '', user.id, created);
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(id, user.id, created);
      db.prepare('INSERT INTO roles(server_id,name,color,position,is_default,permissions,created_at) VALUES (?,?,?,?,1,?,?)')
        .run(id, '@everyone', '#99aab5', 0, DEFAULT_PERMISSIONS, created);
      const category = db.prepare("INSERT INTO channels(server_id,name,type,position,created_at) VALUES (?,'Text Channels','category',0,?)").run(id, created);
      db.prepare("INSERT INTO channels(server_id,parent_id,name,type,position,created_at) VALUES (?,?,'general','text',0,?)")
        .run(id, Number(category.lastInsertRowid), created);
      return id;
    });
    audit(db, config, 'server.created', { actorId: user.id, serverId, targetType: 'server', targetId: serverId, payload: { name } });
    sendJson(response, 201, { server: serializeServer(getServer(serverId)) });
  }, { auth: true });

  router.add('GET', '/api/servers/:id', async ({ response, user, params }) => {
    const server = getServer(asId(params.id));
    const member = db.prepare('SELECT * FROM server_members WHERE server_id=? AND user_id=?').get(server.id, user.id);
    if (!member && !isGlobalAdmin(user)) throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this server.');
    const channels = db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position,id').all(server.id)
      .filter((channel) => hasBit(serverPermissions(db, user, server.id, channel.id), Permissions.VIEW_CHANNEL)).map(serializeChannel);
    const roles = db.prepare('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC,id').all(server.id).map(serializeRole);
    sendJson(response, 200, { server: serializeServer(server), channels, roles, permissions: serverPermissions(db, user, server.id), member });
  }, { auth: true });

  router.add('PATCH', '/api/servers/:id', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    const identityChange = body.name !== undefined || body.description !== undefined;
    const discoveryChange = ['discoverable', 'discoveryMode', 'discoveryCategory', 'discoveryTags'].some((field) => body[field] !== undefined);
    if (!identityChange && !discoveryChange) throw new HttpError(400, 'INVALID_UPDATE', 'Supply a server or discovery setting to update.');
    if (identityChange) requirePermission(user, server.id, Permissions.MANAGE_SERVER);
    if (discoveryChange) requirePermission(user, server.id, Permissions.MANAGE_DISCOVERY);
    const name = body.name === undefined ? server.name : cleanName(body.name, 'Server name', 100);
    const description = body.description === undefined ? server.description : (optionalText(body.description, 'Description', 1000) ?? '');
    let discoverable = body.discoverable === undefined ? server.discoverable : Number(boolean(body.discoverable));
    let mode = body.discoveryMode ?? server.discovery_mode;
    if (!['public', 'invite', 'approval'].includes(mode)) throw new HttpError(400, 'INVALID_DISCOVERY_MODE', 'Discovery mode must be public, invite, or approval.');
    const category = body.discoveryCategory === undefined ? server.discovery_category : optionalText(body.discoveryCategory, 'Discovery category', 50);
    const tags = body.discoveryTags === undefined ? json(server.discovery_tags, []) : body.discoveryTags;
    if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || tag.length > 30)) throw new HttpError(400, 'INVALID_TAGS', 'Supply no more than ten tags of 30 characters each.');
    db.prepare(`UPDATE servers SET name=?,description=?,discoverable=?,discovery_mode=?,discovery_category=?,discovery_tags=? WHERE id=?`)
      .run(name, description, discoverable, mode, category, JSON.stringify(tags), server.id);
    audit(db, config, 'server.updated', { actorId: user.id, serverId: server.id, targetType: 'server', targetId: server.id, payload: { name, discoverable: Boolean(discoverable), mode } });
    broadcastServer(server.id, { type: 'server.updated', server: serializeServer(getServer(server.id)) });
    sendJson(response, 200, { server: serializeServer(getServer(server.id)) });
  }, { auth: true });

  router.add('DELETE', '/api/servers/:id', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    if (server.is_system) throw new HttpError(409, 'PROTECTED_SERVER', 'The mandatory Babcock server cannot be deleted.');
    if (Number(server.owner_id) !== Number(user.id) && !isGlobalAdmin(user)) throw new HttpError(403, 'OWNER_REQUIRED', 'Only the server owner or a platform administrator can delete this server.');
    if (body.confirmName !== server.name) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact current server name to confirm deletion.');
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    const reason = optionalText(body.reason, 'Reason', 500);
    performServerDeletion(server, user, reason);
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/servers/:id/transfer', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    if (server.is_system) throw new HttpError(409, 'PROTECTED_SERVER', 'The mandatory Babcock server cannot be transferred through this endpoint.');
    if (Number(server.owner_id) !== Number(user.id) && user.global_role !== 'owner') throw new HttpError(403, 'OWNER_REQUIRED', 'Only the server owner can transfer ownership.');
    const newOwnerId = asId(body.userId);
    if (!db.prepare('SELECT 1 FROM server_members WHERE server_id=? AND user_id=?').get(server.id, newOwnerId)) throw new HttpError(400, 'NOT_A_MEMBER', 'The new owner must already be a server member.');
    db.prepare('UPDATE servers SET owner_id=? WHERE id=?').run(newOwnerId, server.id);
    audit(db, config, 'server.ownership_transferred', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: newOwnerId });
    broadcastServer(server.id, { type: 'server.updated', server: serializeServer(getServer(server.id)) });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/servers/:id/leave', async ({ response, user, params }) => {
    const server = getServer(asId(params.id));
    if (server.is_system) throw new HttpError(409, 'PROTECTED_SERVER', 'The mandatory Babcock server cannot be left.');
    if (Number(server.owner_id) === Number(user.id)) throw new HttpError(409, 'TRANSFER_REQUIRED', 'Transfer ownership or delete the server before leaving.');
    const result = db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(server.id, user.id);
    if (!result.changes) throw new HttpError(404, 'NOT_A_MEMBER', 'You are not a member of this server.');
    audit(db, config, 'member.left', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: user.id });
    broadcastServer(server.id, { type: 'member.left', serverId: server.id, userId: user.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/servers/:id/channels', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    getServer(serverId);
    const rows = db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position,id').all(serverId)
      .filter((channel) => hasBit(serverPermissions(db, user, serverId, channel.id), Permissions.VIEW_CHANNEL));
    sendJson(response, 200, { channels: rows.map(serializeChannel) });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/channels', async ({ response, user, params, body }) => {
    const serverId = asId(params.id);
    getServer(serverId);
    requirePermission(user, serverId, Permissions.MANAGE_CHANNELS);
    const type = body.type ?? 'text';
    if (!['text', 'category', 'voice'].includes(type)) throw new HttpError(400, 'INVALID_CHANNEL_TYPE', 'Channel type must be text, category, or voice.');
    const name = cleanName(body.name, 'Channel name', 100);
    const topic = optionalText(body.topic, 'Topic', 1024) ?? '';
    const parentId = type === 'category' ? null : asId(body.parentId);
    if (parentId) {
      const parent = getChannel(parentId);
      if (Number(parent.server_id) !== serverId || parent.type !== 'category') throw new HttpError(400, 'INVALID_PARENT', 'The parent must be a category in the same server.');
    }
    const position = boundedInteger(body.position, 'position', 0, 10000, 0);
    const userLimit = type === 'voice' ? boundedInteger(body.userLimit, 'userLimit', 0, 100, 0) : null;
    const result = db.prepare('INSERT INTO channels(server_id,parent_id,name,topic,type,position,user_limit,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(serverId, parentId, name, topic, type, position, userLimit, now());
    const channel = getChannel(Number(result.lastInsertRowid));
    audit(db, config, 'channel.created', { actorId: user.id, serverId, targetType: 'channel', targetId: channel.id, payload: { name, type } });
    broadcastChannel(serverId, channel.id, { type: 'channel.created', channel: serializeChannel(channel) });
    sendJson(response, 201, { channel: serializeChannel(channel) });
  }, { auth: true });

  router.add('PATCH', '/api/channels/:id', async ({ response, user, params, body }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.MANAGE_CHANNELS);
    const name = body.name === undefined ? channel.name : cleanName(body.name, 'Channel name', 100);
    const topic = body.topic === undefined ? channel.topic : (optionalText(body.topic, 'Topic', 1024) ?? '');
    const position = body.position === undefined ? channel.position : boundedInteger(body.position, 'position', 0, 10000, 0);
    const parentId = body.parentId === undefined ? channel.parent_id : asId(body.parentId);
    if (parentId) {
      const parent = getChannel(parentId);
      if (parent.server_id !== channel.server_id || parent.type !== 'category' || parent.id === channel.id) throw new HttpError(400, 'INVALID_PARENT', 'The parent must be another category in this server.');
    }
    const userLimit = channel.type === 'voice' && body.userLimit !== undefined ? boundedInteger(body.userLimit, 'userLimit', 0, 100, 0) : channel.user_limit;
    db.prepare('UPDATE channels SET name=?,topic=?,position=?,parent_id=?,user_limit=? WHERE id=?').run(name, topic, position, parentId, userLimit, channel.id);
    audit(db, config, 'channel.updated', { actorId: user.id, serverId: channel.server_id, targetType: 'channel', targetId: channel.id });
    broadcastChannel(channel.server_id, channel.id, { type: 'channel.updated', channel: serializeChannel(getChannel(channel.id)) });
    sendJson(response, 200, { channel: serializeChannel(getChannel(channel.id)) });
  }, { auth: true });

  router.add('DELETE', '/api/channels/:id', async ({ response, user, params }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.MANAGE_CHANNELS);
    // Capture the authorized audience while channel overrides still exist. They are
    // removed by the channel's cascading delete and must not be lost first.
    const recipients = visibleChannelSockets(channel.server_id, channel.id);
    transaction(db, () => {
      const retainedMessages = retainMessagesBeforeContainerDeletion([channel.id], user.id, channel.server_id, 'Channel deleted');
      audit(db, config, 'channel.deleted', { actorId: user.id, serverId: channel.server_id, targetType: 'channel', targetId: channel.id, payload: { name: channel.name, type: channel.type, retainedMessages } });
      db.prepare('DELETE FROM channels WHERE id=?').run(channel.id);
    });
    broadcastSockets(recipients, { type: 'channel.deleted', channelId: channel.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('PUT', '/api/channels/:id/permissions', async ({ response, user, params, body }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.MANAGE_ROLES);
    const targetType = body.targetType;
    const targetId = asId(body.targetId);
    if (!['role', 'member'].includes(targetType) || !targetId) throw new HttpError(400, 'INVALID_TARGET', 'A role or member target is required.');
    const targetRole = targetType === 'role' ? db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(targetId, channel.server_id) : null;
    if (targetType === 'role' && !targetRole) throw new HttpError(400, 'INVALID_TARGET', 'That role is not in this server.');
    if (targetType === 'member' && !db.prepare('SELECT 1 FROM server_members WHERE server_id=? AND user_id=?').get(channel.server_id, targetId)) throw new HttpError(400, 'INVALID_TARGET', 'That member is not in this server.');
    if (targetRole) requireRoleBelowActor(user, channel.server_id, targetRole.position);
    if (targetType === 'member') requireMemberBelowActor(user, channel.server_id, targetId);
    const allow = boundedInteger(body.allow, 'allow', 0, ALL_PERMISSIONS, 0);
    const deny = boundedInteger(body.deny, 'deny', 0, ALL_PERMISSIONS, 0);
    const actingPermissions = serverPermissions(db, user, channel.server_id);
    if (!isGlobalAdmin(user) && getServer(channel.server_id).owner_id !== user.id && (allow & ~actingPermissions)) throw new HttpError(403, 'PERMISSION_ESCALATION', 'You cannot grant permissions you do not have.');
    db.prepare(`INSERT INTO channel_overrides(channel_id,target_type,target_id,allow_bits,deny_bits) VALUES (?,?,?,?,?)
      ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET allow_bits=excluded.allow_bits,deny_bits=excluded.deny_bits`)
      .run(channel.id, targetType, targetId, allow, deny);
    audit(db, config, 'channel.permissions_updated', { actorId: user.id, serverId: channel.server_id, targetType: 'channel', targetId: channel.id, payload: { targetType, targetId, allow, deny } });
    sendEmpty(response);
  }, { auth: true });

  router.add('DELETE', '/api/channels/:id/permissions/:targetType/:targetId', async ({ response, user, params }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.MANAGE_ROLES);
    const targetId = asId(params.targetId);
    if (params.targetType === 'role') {
      const role = db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(targetId, channel.server_id);
      if (role) requireRoleBelowActor(user, channel.server_id, role.position);
    } else if (params.targetType === 'member') requireMemberBelowActor(user, channel.server_id, targetId);
    db.prepare('DELETE FROM channel_overrides WHERE channel_id=? AND target_type=? AND target_id=?').run(channel.id, params.targetType, targetId);
    audit(db, config, 'channel.permissions_removed', { actorId: user.id, serverId: channel.server_id, targetType: 'channel', targetId: channel.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/servers/:id/roles', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    if (!serverPermissions(db, user, serverId)) throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this server.');
    sendJson(response, 200, { roles: db.prepare('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC,id').all(serverId).map(serializeRole) });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/roles', async ({ response, user, params, body }) => {
    const serverId = asId(params.id);
    getServer(serverId);
    requirePermission(user, serverId, Permissions.MANAGE_ROLES);
    const permissions = boundedInteger(body.permissions, 'permissions', 0, ALL_PERMISSIONS, 0);
    const position = boundedInteger(body.position, 'position', 0, 10000, 1);
    const actingPermissions = serverPermissions(db, user, serverId);
    if (!isGlobalAdmin(user) && getServer(serverId).owner_id !== user.id && (permissions & ~actingPermissions)) throw new HttpError(403, 'PERMISSION_ESCALATION', 'You cannot grant permissions you do not have.');
    requireRoleBelowActor(user, serverId, position);
    const result = db.prepare('INSERT INTO roles(server_id,name,color,position,permissions,created_at) VALUES (?,?,?,?,?,?)').run(
      serverId, cleanName(body.name, 'Role name', 50), roleColor(body.color), position, permissions, now());
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(Number(result.lastInsertRowid));
    audit(db, config, 'role.created', { actorId: user.id, serverId, targetType: 'role', targetId: role.id, payload: { name: role.name, permissions } });
    sendJson(response, 201, { role: serializeRole(role) });
  }, { auth: true });

  router.add('PATCH', '/api/roles/:id', async ({ response, user, params, body }) => {
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(asId(params.id));
    if (!role) throw new HttpError(404, 'ROLE_NOT_FOUND', 'Role not found.');
    requirePermission(user, role.server_id, Permissions.MANAGE_ROLES);
    const name = role.is_default ? role.name : (body.name === undefined ? role.name : cleanName(body.name, 'Role name', 50));
    const color = body.color === undefined ? role.color : roleColor(body.color);
    const position = body.position === undefined ? role.position : boundedInteger(body.position, 'position', 0, 10000, 0);
    const permissions = body.permissions === undefined ? role.permissions : boundedInteger(body.permissions, 'permissions', 0, ALL_PERMISSIONS, 0);
    const actingPermissions = serverPermissions(db, user, role.server_id);
    if (!isGlobalAdmin(user) && getServer(role.server_id).owner_id !== user.id && (permissions & ~actingPermissions)) throw new HttpError(403, 'PERMISSION_ESCALATION', 'You cannot grant permissions you do not have.');
    requireRoleBelowActor(user, role.server_id, role.position);
    requireRoleBelowActor(user, role.server_id, position);
    db.prepare('UPDATE roles SET name=?,color=?,position=?,permissions=? WHERE id=?').run(name, color, position, permissions, role.id);
    audit(db, config, 'role.updated', { actorId: user.id, serverId: role.server_id, targetType: 'role', targetId: role.id, payload: { permissions } });
    sendJson(response, 200, { role: serializeRole(db.prepare('SELECT * FROM roles WHERE id=?').get(role.id)) });
  }, { auth: true });

  router.add('DELETE', '/api/roles/:id', async ({ response, user, params }) => {
    const role = db.prepare('SELECT * FROM roles WHERE id=?').get(asId(params.id));
    if (!role) throw new HttpError(404, 'ROLE_NOT_FOUND', 'Role not found.');
    requirePermission(user, role.server_id, Permissions.MANAGE_ROLES);
    if (role.is_default) throw new HttpError(409, 'PROTECTED_ROLE', 'The default role cannot be deleted.');
    requireRoleBelowActor(user, role.server_id, role.position);
    audit(db, config, 'role.deleted', { actorId: user.id, serverId: role.server_id, targetType: 'role', targetId: role.id, payload: { name: role.name } });
    db.prepare('DELETE FROM roles WHERE id=?').run(role.id);
    sendEmpty(response);
  }, { auth: true });

  router.add('PUT', '/api/servers/:id/members/:userId/roles/:roleId', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.MANAGE_ROLES);
    const memberId = asId(params.userId);
    const roleId = asId(params.roleId);
    if (!db.prepare('SELECT 1 FROM server_members WHERE server_id=? AND user_id=?').get(serverId, memberId)) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
    const role = db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(roleId, serverId);
    if (!role || role.is_default) throw new HttpError(404, 'ROLE_NOT_FOUND', 'Assignable role not found.');
    requireMemberBelowActor(user, serverId, memberId);
    requireRoleBelowActor(user, serverId, role.position);
    const actingPermissions = serverPermissions(db, user, serverId);
    if (!isGlobalAdmin(user) && getServer(serverId).owner_id !== user.id && (Number(role.permissions) & ~actingPermissions)) throw new HttpError(403, 'PERMISSION_ESCALATION', 'You cannot assign a role with permissions you do not have.');
    db.prepare('INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id,assigned_at) VALUES (?,?,?,?)').run(serverId, memberId, roleId, now());
    audit(db, config, 'member.role_assigned', { actorId: user.id, serverId, targetType: 'user', targetId: memberId, payload: { roleId } });
    sendEmpty(response);
  }, { auth: true });

  router.add('DELETE', '/api/servers/:id/members/:userId/roles/:roleId', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.MANAGE_ROLES);
    const memberId = asId(params.userId);
    const roleId = asId(params.roleId);
    const role = db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(roleId, serverId);
    if (!role || role.is_default) throw new HttpError(404, 'ROLE_NOT_FOUND', 'Assignable role not found.');
    requireMemberBelowActor(user, serverId, memberId);
    requireRoleBelowActor(user, serverId, role.position);
    db.prepare('DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?').run(serverId, memberId, roleId);
    audit(db, config, 'member.role_removed', { actorId: user.id, serverId, targetType: 'user', targetId: memberId, payload: { roleId } });
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/servers/:id/members', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    if (!serverPermissions(db, user, serverId)) throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this server.');
    const members = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar_path,u.global_role,u.status,u.created_at,m.nickname,m.joined_at,m.muted_until,
      (SELECT json_group_array(role_id) FROM member_roles WHERE server_id=m.server_id AND user_id=m.user_id) role_ids
      FROM server_members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY lower(COALESCE(m.nickname,u.display_name))`).all(serverId)
      .map((row) => ({ user: publicUser(row), nickname: row.nickname, joinedAt: row.joined_at, mutedUntil: row.muted_until, roleIds: json(row.role_ids, []) }));
    sendJson(response, 200, { members });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/kick', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    requirePermission(user, server.id, Permissions.KICK_MEMBERS);
    const target = asId(body.userId);
    const targetUser = db.prepare('SELECT * FROM users WHERE id=?').get(target);
    if (server.is_system) throw new HttpError(409, 'PROTECTED_SERVER', 'Members cannot be removed from the mandatory server.');
    if (target === user.id || targetUser?.global_role === 'owner' || (isGlobalAdmin(targetUser) && !isGlobalAdmin(user))) throw new HttpError(409, 'PROTECTED_MEMBER', 'That member cannot be kicked.');
    const successor = await moderationOwnerSuccessor(server, user, target, targetUser, body);
    requireMemberBelowActor(user, server.id, target);
    transaction(db, () => {
      if (successor) {
        db.prepare('UPDATE servers SET owner_id=? WHERE id=?').run(successor.id, server.id);
        audit(db, config, 'server.owner_transferred_for_moderation', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: successor.id, reason: optionalText(body.reason, 'Reason', 500), payload: { previousOwnerId: target, newOwnerId: successor.id, action: 'kick' } });
      }
      const result = db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(server.id, target);
      if (!result.changes) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
      audit(db, config, 'member.kicked', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: target, reason: optionalText(body.reason, 'Reason', 500) });
    });
    broadcastServer(server.id, { type: 'member.kicked', serverId: server.id, userId: target });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/servers/:id/ban', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    requirePermission(user, server.id, Permissions.BAN_MEMBERS);
    const target = asId(body.userId);
    const targetUser = db.prepare('SELECT * FROM users WHERE id=?').get(target);
    if (target === user.id || targetUser?.global_role === 'owner' || (isGlobalAdmin(targetUser) && !isGlobalAdmin(user))) throw new HttpError(409, 'PROTECTED_MEMBER', 'That member cannot be banned.');
    const successor = await moderationOwnerSuccessor(server, user, target, targetUser, body);
    requireMemberBelowActor(user, server.id, target);
    const expiresAt = body.durationMinutes ? now() + boundedInteger(body.durationMinutes, 'durationMinutes', 1, 525600, 1) * 60_000 : null;
    transaction(db, () => {
      if (successor) {
        db.prepare('UPDATE servers SET owner_id=? WHERE id=?').run(successor.id, server.id);
        audit(db, config, 'server.owner_transferred_for_moderation', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: successor.id, reason: optionalText(body.reason, 'Reason', 500), payload: { previousOwnerId: target, newOwnerId: successor.id, action: 'ban' } });
      }
      db.prepare(`INSERT INTO server_bans(server_id,user_id,actor_id,reason,created_at,expires_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(server_id,user_id) DO UPDATE SET actor_id=excluded.actor_id,reason=excluded.reason,created_at=excluded.created_at,expires_at=excluded.expires_at`)
        .run(server.id, target, user.id, optionalText(body.reason, 'Reason', 500), now(), expiresAt);
      if (!server.is_system) db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(server.id, target);
      audit(db, config, 'member.banned', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: target, reason: optionalText(body.reason, 'Reason', 500), payload: { expiresAt } });
    });
    broadcastServer(server.id, { type: 'member.banned', serverId: server.id, userId: target, expiresAt });
    sendEmpty(response);
  }, { auth: true });

  router.add('DELETE', '/api/servers/:id/bans/:userId', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.BAN_MEMBERS);
    db.prepare('DELETE FROM server_bans WHERE server_id=? AND user_id=?').run(serverId, asId(params.userId));
    audit(db, config, 'member.unbanned', { actorId: user.id, serverId, targetType: 'user', targetId: asId(params.userId) });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/servers/:id/mute', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    requirePermission(user, server.id, Permissions.MUTE_MEMBERS);
    const target = asId(body.userId);
    const targetUser = db.prepare('SELECT * FROM users WHERE id=?').get(target);
    if (target === user.id || targetUser?.global_role === 'owner' || (Number(target) === Number(server.owner_id) && !isGlobalAdmin(user)) || (isGlobalAdmin(targetUser) && !isGlobalAdmin(user))) throw new HttpError(409, 'PROTECTED_MEMBER', 'That member cannot be muted.');
    requireMemberBelowActor(user, server.id, target);
    if (body.unmute === true && (body.indefinite === true || body.durationMinutes !== undefined)) throw new HttpError(400, 'INVALID_MUTE', 'Choose unmute, indefinite, or a duration—not more than one.');
    if (body.indefinite === true && body.durationMinutes !== undefined) throw new HttpError(400, 'INVALID_MUTE', 'Choose indefinite or a duration—not both.');
    const until = body.unmute === true ? null : body.indefinite === true ? INDEFINITE_MUTE_UNTIL
      : now() + boundedInteger(body.durationMinutes, 'durationMinutes', 1, 43200, 10) * 60_000;
    transaction(db, () => {
      const result = db.prepare('UPDATE server_members SET muted_until=? WHERE server_id=? AND user_id=?').run(until, server.id, target);
      if (!result.changes) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
      audit(db, config, until ? 'member.muted' : 'member.unmuted', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: target, reason: optionalText(body.reason, 'Reason', 500), payload: { until, indefinite: until === INDEFINITE_MUTE_UNTIL } });
    });
    sendJson(response, 200, { mutedUntil: until, indefinite: until === INDEFINITE_MUTE_UNTIL });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/invites', async ({ request, response, user, params, body }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.CREATE_INVITES);
    limiter.check('invite-create', user.id, 20, 3_600_000);
    const code = randomToken(9);
    const maxUses = Number(body.maxUses) === 0 ? null : boundedInteger(body.maxUses, 'maxUses', 1, 10000, null);
    const expiresAt = body.expiresInMinutes ? now() + boundedInteger(body.expiresInMinutes, 'expiresInMinutes', 1, 525600, 1) * 60_000 : null;
    db.prepare('INSERT INTO invites(server_id,code,creator_id,max_uses,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(serverId, code, user.id, maxUses, expiresAt, now());
    audit(db, config, 'invite.created', { actorId: user.id, serverId, targetType: 'invite', payload: { code, maxUses, expiresAt } });
    sendJson(response, 201, { invite: { code, serverId, maxUses, uses: 0, expiresAt } });
  }, { auth: true });

  router.add('GET', '/api/servers/:id/invites', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.MANAGE_SERVER);
    const invites = db.prepare('SELECT id,code,creator_id,max_uses,uses,expires_at,revoked_at,created_at FROM invites WHERE server_id=? ORDER BY created_at DESC').all(serverId)
      .map((invite) => ({ ...invite, creatorId: invite.creator_id, maxUses: invite.max_uses, expiresAt: invite.expires_at, revokedAt: invite.revoked_at, createdAt: invite.created_at }));
    sendJson(response, 200, { invites });
  }, { auth: true });

  router.add('DELETE', '/api/invites/:code', async ({ response, user, params }) => {
    const invite = db.prepare('SELECT * FROM invites WHERE code=?').get(params.code);
    if (!invite) throw new HttpError(404, 'INVITE_NOT_FOUND', 'Invite not found.');
    if (invite.creator_id !== user.id) requirePermission(user, invite.server_id, Permissions.MANAGE_SERVER);
    db.prepare('UPDATE invites SET revoked_at=? WHERE id=?').run(now(), invite.id);
    audit(db, config, 'invite.revoked', { actorId: user.id, serverId: invite.server_id, targetType: 'invite', targetId: invite.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/invites/:code/join', async ({ response, user, params }) => {
    const invite = db.prepare('SELECT * FROM invites WHERE code=? AND revoked_at IS NULL').get(params.code);
    if (!invite || (invite.expires_at && invite.expires_at < now()) || (invite.max_uses && invite.uses >= invite.max_uses)) throw new HttpError(404, 'INVALID_INVITE', 'This invite is invalid or expired.');
    const ban = db.prepare('SELECT * FROM server_bans WHERE server_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)').get(invite.server_id, user.id, now());
    if (ban) throw new HttpError(403, 'BANNED', 'You are banned from this server.');
    transaction(db, () => {
      const added = db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(invite.server_id, user.id, now());
      if (added.changes) db.prepare('UPDATE invites SET uses=uses+1 WHERE id=?').run(invite.id);
    });
    audit(db, config, 'member.joined', { actorId: user.id, serverId: invite.server_id, targetType: 'user', targetId: user.id, payload: { inviteId: invite.id } });
    broadcastServer(invite.server_id, { type: 'member.joined', serverId: invite.server_id, user: publicUser(user) });
    sendJson(response, 200, { server: serializeServer(getServer(invite.server_id)) });
  }, { auth: true });

  // Attachments are stored byte-for-byte. There is deliberately no archive or HTML inspection.
  router.add('POST', '/api/uploads', async ({ request, response, user, url }) => {
    assertActiveForMessaging(user);
    limiter.check('upload', user.id, 20, 3_600_000);
    const supplied = url.searchParams.get('filename') ?? request.headers['x-file-name'];
    const name = basename(requireText(supplied, 'filename', 1, 200));
    const extension = extname(name).toLowerCase();
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.docx', '.pptx', '.xlsx', '.zip', '.html', '.htm']);
    if (!allowed.has(extension)) throw new HttpError(415, 'FILE_TYPE_NOT_ALLOWED', 'That file type is not allowed.');
    const contentType = String(request.headers['content-type'] ?? 'application/octet-stream').slice(0, 150);
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    const sizeLimit = imageExtensions.has(extension) || isImageType(contentType) ? config.maxImageBytes : config.maxFileBytes;
    const bytes = await readBuffer(request, sizeLimit);
    if (!bytes.length) throw new HttpError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
    const storedName = `${randomUUID()}${extension}`;
    const destination = resolve(config.attachmentDir, storedName);
    writeFileSync(destination, bytes, { flag: 'wx' });
    const result = db.prepare(`INSERT INTO attachments(uploader_id,original_name,stored_name,content_type,size,created_at)
      VALUES (?,?,?,?,?,?)`).run(user.id, name, storedName, contentType, bytes.length, now());
    const attachmentId = Number(result.lastInsertRowid);
    audit(db, config, 'attachment.uploaded', { actorId: user.id, targetType: 'attachment', targetId: attachmentId, payload: { name, contentType, size: bytes.length } });
    sendJson(response, 201, { attachment: { id: attachmentId, name, contentType, size: bytes.length, url: `/api/attachments/${attachmentId}` } });
  }, { auth: true, raw: true });

  router.add('GET', '/api/attachments/:id', async ({ response, user, params }) => {
    const attachment = db.prepare('SELECT * FROM attachments WHERE id=?').get(asId(params.id));
    if (!attachment) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found.');
    if (attachment.message_id) {
      const message = db.prepare('SELECT * FROM messages WHERE id=?').get(attachment.message_id);
      if (!message) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      if (message.channel_id) {
        const channel = getChannel(message.channel_id);
        requirePermission(user, channel.server_id, attachment.deleted_at ? Permissions.VIEW_AUDIT_LOG : Permissions.VIEW_CHANNEL, channel.id);
        audit(db, config, 'attachment.downloaded', { actorId: user.id, serverId: channel.server_id, messageId: message.id, targetType: 'attachment', targetId: attachment.id, payload: { name: attachment.original_name, size: attachment.size, deleted: Boolean(attachment.deleted_at) } });
      } else {
        const access = dmAccess(user, message.dm_id, true);
        if (attachment.deleted_at && !access.admin) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found.');
        if (access.admin) audit(db, config, 'admin.dm_attachment_downloaded', { actorId: user.id, dmId: message.dm_id, messageId: message.id, targetType: 'attachment', targetId: attachment.id, reason: access.access.reason, payload: { name: attachment.original_name, size: attachment.size } });
        else audit(db, config, 'attachment.downloaded', { actorId: user.id, dmId: message.dm_id, messageId: message.id, targetType: 'attachment', targetId: attachment.id, payload: { name: attachment.original_name, size: attachment.size } });
      }
    } else {
      if (attachment.deleted_at) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found.');
      if (attachment.uploader_id !== user.id) throw new HttpError(403, 'ATTACHMENT_ACCESS_DENIED', 'You do not have access to this attachment.');
    }
    const extension = extname(attachment.original_name).toLowerCase();
    const alwaysDownload = extension === '.zip' || extension === '.html' || extension === '.htm';
    const served = serveFile(response, config.attachmentDir, attachment.stored_name, {
      'Content-Type': attachment.content_type,
      'Content-Disposition': contentDisposition(attachment.original_name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=300',
      ...(alwaysDownload ? { 'Cross-Origin-Resource-Policy': 'same-site' } : {}),
    });
    if (!served) throw new HttpError(404, 'ATTACHMENT_FILE_MISSING', 'The attachment record exists, but its file is unavailable.');
  }, { auth: true });

  function assertMessageScope(user, message, permission = Permissions.VIEW_CHANNEL) {
    if (message.channel_id) {
      const channel = getChannel(message.channel_id);
      requirePermission(user, channel.server_id, permission, channel.id);
      return { channel, serverId: channel.server_id };
    }
    return dmAccess(user, message.dm_id, true);
  }

  function validateMessageBody(body) {
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length > 4000) throw new HttpError(400, 'MESSAGE_TOO_LONG', 'Messages may contain at most 4,000 characters.');
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > config.maxAttachmentsPerMessage || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new HttpError(400, 'INVALID_ATTACHMENTS', `A message may contain up to ${config.maxAttachmentsPerMessage} unique attachments.`);
    }
    if (!content && !attachmentIds.length) throw new HttpError(400, 'EMPTY_MESSAGE', 'A message must contain text or an attachment.');
    return { content, attachmentIds: attachmentIds.map(asId) };
  }

  function validateReply(replyId, channelId, dmId) {
    if (!replyId) return null;
    const reply = db.prepare('SELECT * FROM messages WHERE id=?').get(asId(replyId));
    if (!reply || reply.channel_id !== channelId || reply.dm_id !== dmId) throw new HttpError(400, 'INVALID_REPLY', 'The replied-to message is not in this conversation.');
    return reply.id;
  }

  function attachUploads(userId, messageId, attachmentIds) {
    const select = db.prepare(`SELECT * FROM attachments WHERE id=? AND uploader_id=? AND message_id IS NULL
      AND purpose='message' AND deleted_at IS NULL AND created_at>?`);
    const update = db.prepare(`UPDATE attachments SET message_id=? WHERE id=? AND message_id IS NULL
      AND purpose='message' AND deleted_at IS NULL`);
    for (const id of attachmentIds) {
      const item = select.get(id, userId, now() - 3_600_000);
      if (!item) throw new HttpError(400, 'INVALID_ATTACHMENT', 'An attachment is invalid, already used, or expired.');
      if (!update.run(messageId, id).changes) throw new HttpError(400, 'INVALID_ATTACHMENT', 'An attachment is invalid, already used, or expired.');
    }
  }

  function createMessage(user, { channelId = null, dmId = null, content, attachmentIds, replyToId, administration = false, auditRecord = null }) {
    return transaction(db, () => {
      const result = db.prepare(`INSERT INTO messages(author_id,channel_id,dm_id,content,reply_to_id,administration,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(user.id, channelId, dmId, content, replyToId, administration ? 1 : 0, now());
      const messageId = Number(result.lastInsertRowid);
      attachUploads(user.id, messageId, attachmentIds);
      const normalizedMentions = [...String(content).matchAll(/@([a-zA-Z0-9_.-]{3,32})/g)].map((match) => normalizeUsername(match[1]));
      const insertMention = db.prepare('INSERT OR IGNORE INTO message_mentions(message_id,user_id) VALUES (?,?)');
      for (const username of new Set(normalizedMentions)) {
        const mentioned = db.prepare("SELECT id FROM users WHERE username_norm=? AND status!='deleted'").get(username);
        if (mentioned) insertMention.run(messageId, mentioned.id);
      }
      if (auditRecord) audit(db, config, auditRecord.type, {
        actorId: user.id,
        ...auditRecord.details,
        messageId,
        targetType: 'message',
        targetId: messageId,
      });
      return messageId;
    });
  }

  router.add('GET', '/api/channels/:id/messages', async ({ response, user, params, url }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.VIEW_CHANNEL, channel.id);
    const limit = pageLimit(url);
    const before = boundedInteger(url.searchParams.get('before'), 'before', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const q = String(url.searchParams.get('q') ?? '').trim();
    const rows = q ? db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id=? AND m.id<? AND m.deleted_at IS NULL AND m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(channel.id, before, `%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, limit)
      : db.prepare(`${MESSAGE_SELECT} WHERE m.channel_id=? AND m.id<? ORDER BY m.id DESC LIMIT ?`).all(channel.id, before, limit);
    sendJson(response, 200, { messages: rows.reverse().map(serializeMessage), hasMore: rows.length === limit });
  }, { auth: true });

  router.add('POST', '/api/channels/:id/messages', async ({ request, response, user, params, body }) => {
    limiter.check('message', user.id, 10, 10_000);
    const channel = getChannel(asId(params.id));
    if (channel.type !== 'text') throw new HttpError(409, 'NOT_TEXT_CHANNEL', 'Messages can only be sent to text channels.');
    requirePermission(user, channel.server_id, Permissions.SEND_MESSAGES, channel.id);
    assertParticipationAllowed(user, channel.server_id);
    const messageBody = validateMessageBody(body);
    const replyToId = validateReply(body.replyToId, channel.id, null);
    const messageId = createMessage(user, {
      channelId: channel.id,
      ...messageBody,
      replyToId,
      auditRecord: { type: 'message.created', details: { serverId: channel.server_id, payload: { content: messageBody.content, attachmentIds: messageBody.attachmentIds, replyToId } } },
    });
    const message = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(messageId));
    broadcastChannel(channel.server_id, channel.id, { type: 'message.created', message });
    sendJson(response, 201, { message });
  }, { auth: true });

  router.add('PATCH', '/api/messages/:id', async ({ response, user, params, body }) => {
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(asId(params.id));
    if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    const access = assertMessageScope(user, message);
    assertParticipationAllowed(user, access.serverId ?? null);
    if (message.deleted_at) throw new HttpError(409, 'MESSAGE_DELETED', 'Deleted messages cannot be edited.');
    if (Number(message.author_id) !== Number(user.id)) throw new HttpError(403, 'NOT_MESSAGE_AUTHOR', 'You can only edit your own messages.');
    const content = requireText(body.content, 'Message', 1, 4000);
    const editedAt = now();
    const scope = message.channel_id ? { serverId: access.serverId } : { dmId: message.dm_id };
    transaction(db, () => {
      db.prepare('INSERT INTO message_edits(message_id,editor_id,old_content,new_content,created_at) VALUES (?,?,?,?,?)').run(message.id, user.id, message.content, content, editedAt);
      db.prepare('UPDATE messages SET content=?,edited_at=? WHERE id=?').run(content, editedAt, message.id);
      audit(db, config, 'message.edited', { actorId: user.id, ...scope, messageId: message.id, targetType: 'message', targetId: message.id, payload: { oldContent: message.content, newContent: content } });
    });
    const serialized = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(message.id));
    if (message.channel_id) broadcastChannel(scope.serverId, message.channel_id, { type: 'message.updated', message: serialized });
    else broadcastDm(message.dm_id, { type: 'message.updated', message: serialized });
    sendJson(response, 200, { message: serialized });
  }, { auth: true });

  router.add('DELETE', '/api/messages/:id', async ({ response, user, params, body }) => {
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(asId(params.id));
    if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    const scope = assertMessageScope(user, message);
    if (message.deleted_at) return sendEmpty(response);
    const own = Number(message.author_id) === Number(user.id);
    let moderator = false;
    if (message.channel_id && !own) moderator = hasBit(serverPermissions(db, user, scope.serverId, message.channel_id), Permissions.MANAGE_MESSAGES);
    if (message.dm_id && !own) moderator = isGlobalAdmin(user) && scope.admin;
    if (!own && !moderator) throw new HttpError(403, 'DELETE_DENIED', 'You cannot delete this message.');
    if (!own && isGlobalAdmin(user) && body.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Administrative deletion requires confirmation.');
    const deletedAt = now();
    const attachmentRows = db.prepare('SELECT id,original_name,content_type,size FROM attachments WHERE message_id=?').all(message.id);
    const logScope = message.channel_id ? { serverId: scope.serverId } : { dmId: message.dm_id };
    transaction(db, () => {
      db.prepare('UPDATE messages SET content=NULL,deleted_at=?,deleted_by=? WHERE id=?').run(deletedAt, user.id, message.id);
      db.prepare('UPDATE attachments SET deleted_at=? WHERE message_id=?').run(deletedAt, message.id);
      audit(db, config, 'message.deleted', { actorId: user.id, ...logScope, messageId: message.id, targetType: 'message', targetId: message.id, reason: optionalText(body.reason, 'Reason', 500), payload: { originalContent: message.content, attachments: attachmentRows, originalAuthorId: message.author_id, deletedAt } });
    });
    const serialized = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(message.id));
    const deletionEvent = { type: 'message.deleted', message: serialized, id: message.id, messageId: message.id, deletedAt };
    if (message.channel_id) broadcastChannel(scope.serverId, message.channel_id, deletionEvent);
    else broadcastDm(message.dm_id, deletionEvent);
    sendEmpty(response);
  }, { auth: true });

  router.add('PUT', '/api/messages/:id/reactions/:emoji', async ({ response, user, params }) => {
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(asId(params.id));
    if (!message || message.deleted_at) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    const scope = assertMessageScope(user, message);
    assertParticipationAllowed(user, scope.serverId ?? null);
    const emoji = requireText(params.emoji, 'Emoji', 1, 32);
    db.prepare('INSERT OR IGNORE INTO reactions(message_id,user_id,emoji,created_at) VALUES (?,?,?,?)').run(message.id, user.id, emoji, now());
    audit(db, config, 'reaction.added', { actorId: user.id, serverId: scope.serverId, dmId: message.dm_id, messageId: message.id, targetType: 'message', targetId: message.id, payload: { emoji } });
    const serialized = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(message.id));
    if (message.channel_id) broadcastChannel(scope.serverId, message.channel_id, { type: 'message.updated', message: serialized }); else broadcastDm(message.dm_id, { type: 'message.updated', message: serialized });
    sendEmpty(response);
  }, { auth: true });

  router.add('DELETE', '/api/messages/:id/reactions/:emoji', async ({ response, user, params }) => {
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(asId(params.id));
    if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
    const scope = assertMessageScope(user, message);
    assertParticipationAllowed(user, scope.serverId ?? null);
    db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(message.id, user.id, params.emoji);
    audit(db, config, 'reaction.removed', { actorId: user.id, serverId: scope.serverId, dmId: message.dm_id, messageId: message.id, targetType: 'message', targetId: message.id, payload: { emoji: params.emoji } });
    const serialized = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(message.id));
    if (message.channel_id) broadcastChannel(scope.serverId, message.channel_id, { type: 'message.updated', message: serialized }); else broadcastDm(message.dm_id, { type: 'message.updated', message: serialized });
    sendEmpty(response);
  }, { auth: true });

  router.add('PUT', '/api/channels/:id/read', async ({ response, user, params, body }) => {
    const channel = getChannel(asId(params.id));
    requirePermission(user, channel.server_id, Permissions.VIEW_CHANNEL, channel.id);
    const messageId = asId(body.messageId);
    if (!db.prepare('SELECT 1 FROM messages WHERE id=? AND channel_id=?').get(messageId, channel.id)) throw new HttpError(400, 'INVALID_MESSAGE', 'That message is not in this channel.');
    db.prepare(`INSERT INTO channel_reads(channel_id,user_id,message_id,read_at) VALUES (?,?,?,?)
      ON CONFLICT(channel_id,user_id) DO UPDATE SET message_id=excluded.message_id,read_at=excluded.read_at`).run(channel.id, user.id, messageId, now());
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/channels/:id/voice-attempt', async ({ response, user, params }) => {
    const channel = getChannel(asId(params.id));
    if (channel.type !== 'voice') throw new HttpError(400, 'NOT_VOICE_CHANNEL', 'This is not a voice channel.');
    requirePermission(user, channel.server_id, Permissions.VIEW_CHANNEL, channel.id);
    db.prepare('INSERT INTO voice_attempts(user_id,channel_id,created_at) VALUES (?,?,?)').run(user.id, channel.id, now());
    audit(db, config, 'voice.placeholder_opened', { actorId: user.id, serverId: channel.server_id, targetType: 'channel', targetId: channel.id });
    sendJson(response, 200, { available: false, title: 'Feature Under Construction!', message: 'Voice channels are planned for a future Babcord update.' });
  }, { auth: true });

  // Direct messages and message requests.
  router.add('GET', '/api/users/search', async ({ response, user, url }) => {
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (q.length < 2) return sendJson(response, 200, { users: [] });
    const rows = db.prepare(`SELECT * FROM users WHERE id!=? AND status='active' AND
      (username_norm LIKE ? OR lower(display_name) LIKE ?) ORDER BY CASE WHEN username_norm=? THEN 0 ELSE 1 END,username_norm LIMIT 20`)
      .all(user.id, `${q}%`, `%${q}%`, q);
    sendJson(response, 200, { users: rows.map(publicUser) });
  }, { auth: true });

  router.add('GET', '/api/dms', async ({ response, user }) => {
    const conversations = db.prepare(`SELECT d.id,d.created_at,p.request_state,p.last_read_message_id,
      (SELECT MAX(created_at) FROM messages WHERE dm_id=d.id) last_message_at
      FROM dm_conversations d JOIN dm_participants p ON p.dm_id=d.id
      WHERE p.user_id=? AND NOT EXISTS (
        SELECT 1 FROM dm_participants declined WHERE declined.dm_id=d.id AND declined.request_state='declined'
      ) ORDER BY COALESCE(last_message_at,d.created_at) DESC`).all(user.id).map((row) => {
        const participants = db.prepare(`SELECT u.* FROM dm_participants p JOIN users u ON u.id=p.user_id WHERE p.dm_id=? ORDER BY u.id`).all(row.id).map(publicUser);
        const last = db.prepare(`${MESSAGE_SELECT} WHERE m.dm_id=? ORDER BY m.id DESC LIMIT 1`).get(row.id);
        return { id: row.id, createdAt: row.created_at, requestState: row.request_state, lastReadMessageId: row.last_read_message_id, participants, lastMessage: last ? serializeMessage(last) : null };
      });
    sendJson(response, 200, { conversations });
  }, { auth: true });

  router.add('POST', '/api/dms', async ({ request, response, user, body }) => {
    assertActiveForMessaging(user);
    limiter.check('new-dm', user.id, 10, 3_600_000);
    const otherId = asId(body.userId);
    if (!otherId || otherId === user.id) throw new HttpError(400, 'INVALID_RECIPIENT', 'Choose another user.');
    const other = db.prepare("SELECT * FROM users WHERE id=? AND status!='deleted'").get(otherId);
    if (!other) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    const blocked = db.prepare(`SELECT 1 FROM dm_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)`).get(user.id, otherId, otherId, user.id);
    if (blocked) throw new HttpError(403, 'DM_BLOCKED', 'A block prevents this direct message.');
    let dm = db.prepare(`SELECT d.* FROM dm_conversations d JOIN dm_participants p ON p.dm_id=d.id
      WHERE p.user_id IN (?,?) GROUP BY d.id HAVING COUNT(*)=2 AND COUNT(DISTINCT p.user_id)=2 AND
      (SELECT COUNT(*) FROM dm_participants p2 WHERE p2.dm_id=d.id)=2 LIMIT 1`).get(user.id, otherId);
    if (dm && dmIsDeclined(dm.id)) throw new HttpError(403, 'DM_DECLINED', 'This direct-message request was declined.');
    if (!dm) {
      const created = now();
      const dmId = transaction(db, () => {
        const result = db.prepare('INSERT INTO dm_conversations(created_at) VALUES (?)').run(created);
        const id = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO dm_participants(dm_id,user_id,request_state,joined_at) VALUES (?,?,'accepted',?)").run(id, user.id, created);
        db.prepare("INSERT INTO dm_participants(dm_id,user_id,request_state,joined_at) VALUES (?,?,'pending',?)").run(id, otherId, created);
        return id;
      });
      dm = db.prepare('SELECT * FROM dm_conversations WHERE id=?').get(dmId);
      audit(db, config, 'dm.created', { actorId: user.id, dmId, targetType: 'user', targetId: otherId });
    }
    sendJson(response, 201, { conversation: { id: dm.id, createdAt: dm.created_at, participants: [publicUser(user), publicUser(other)] } });
  }, { auth: true });

  router.add('POST', '/api/dms/:id/accept', async ({ response, user, params }) => {
    const access = dmAccess(user, asId(params.id));
    if (access.admin) throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'Administrators cannot accept a user message request.');
    db.prepare("UPDATE dm_participants SET request_state='accepted' WHERE dm_id=? AND user_id=?").run(access.dm.id, user.id);
    audit(db, config, 'dm.request_accepted', { actorId: user.id, dmId: access.dm.id, targetType: 'dm', targetId: access.dm.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/dms/:id/decline', async ({ response, user, params }) => {
    const access = dmAccess(user, asId(params.id));
    if (access.admin) throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'Administrators cannot decline a user message request.');
    db.prepare("UPDATE dm_participants SET request_state='declined' WHERE dm_id=? AND user_id=?").run(access.dm.id, user.id);
    audit(db, config, 'dm.request_declined', { actorId: user.id, dmId: access.dm.id, targetType: 'dm', targetId: access.dm.id });
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/dms/:id/messages', async ({ response, user, params, url }) => {
    const access = dmAccess(user, asId(params.id), true);
    if (access.admin) db.prepare('UPDATE admin_dm_access SET last_access_at=? WHERE id=?').run(now(), access.access.id);
    const limit = pageLimit(url);
    const before = boundedInteger(url.searchParams.get('before'), 'before', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const q = String(url.searchParams.get('q') ?? '').trim();
    const rows = q ? db.prepare(`${MESSAGE_SELECT} WHERE m.dm_id=? AND m.id<? AND m.deleted_at IS NULL AND m.content LIKE ? ORDER BY m.id DESC LIMIT ?`).all(access.dm.id, before, `%${q}%`, limit)
      : db.prepare(`${MESSAGE_SELECT} WHERE m.dm_id=? AND m.id<? ORDER BY m.id DESC LIMIT ?`).all(access.dm.id, before, limit);
    if (access.admin) audit(db, config, 'admin.dm_messages_viewed', { actorId: user.id, dmId: access.dm.id, targetType: 'dm', targetId: access.dm.id, reason: access.access.reason, payload: { count: rows.length, queryUsed: Boolean(q) } });
    sendJson(response, 200, { messages: rows.reverse().map(serializeMessage), hasMore: rows.length === limit, administrativeAccess: Boolean(access.admin), administrationBanner: access.admin ? 'You are viewing private messages through an audited administrative access session.' : null });
  }, { auth: true });

  router.add('POST', '/api/dms/:id/messages', async ({ request, response, user, params, body }) => {
    assertParticipationAllowed(user);
    limiter.check('message', user.id, 10, 10_000);
    const access = dmAccess(user, asId(params.id), true);
    if (!access.admin && dmIsDeclined(access.dm.id)) throw new HttpError(403, 'DM_DECLINED', 'This direct-message request was declined.');
    if (!access.admin && access.participant.request_state === 'declined') throw new HttpError(403, 'DM_DECLINED', 'This message request was declined.');
    if (!access.admin && access.participant.request_state === 'pending') throw new HttpError(403, 'DM_REQUEST_PENDING', 'Accept this message request before replying.');
    if (access.admin && body.administration !== true) throw new HttpError(400, 'ADMINISTRATION_HANDLE_REQUIRED', 'Administrative DM messages must be sent with the Administration identity.');
    const participants = db.prepare('SELECT user_id FROM dm_participants WHERE dm_id=?').all(access.dm.id).map((row) => row.user_id);
    if (!access.admin) {
      const otherId = participants.find((id) => Number(id) !== Number(user.id));
      if (db.prepare('SELECT 1 FROM dm_blocks WHERE blocker_id=? AND blocked_id=?').get(otherId, user.id) || db.prepare('SELECT 1 FROM dm_blocks WHERE blocker_id=? AND blocked_id=?').get(user.id, otherId)) {
        throw new HttpError(403, 'DM_BLOCKED', 'A block prevents this direct message.');
      }
    }
    const messageBody = validateMessageBody(body);
    const replyToId = validateReply(body.replyToId, null, access.dm.id);
    const messageId = createMessage(user, {
      dmId: access.dm.id,
      ...messageBody,
      replyToId,
      administration: access.admin,
      auditRecord: {
        type: access.admin ? 'dm.administration_message_sent' : 'message.created',
        details: { dmId: access.dm.id, reason: access.admin ? access.access.reason : null, payload: { content: messageBody.content, attachmentIds: messageBody.attachmentIds, replyToId, visibleAuthor: access.admin ? 'Administration' : user.display_name } },
      },
    });
    const message = serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).get(messageId));
    broadcastDm(access.dm.id, { type: 'message.created', message });
    sendJson(response, 201, { message });
  }, { auth: true });

  router.add('PUT', '/api/dms/:id/read', async ({ response, user, params, body }) => {
    const access = dmAccess(user, asId(params.id));
    if (access.admin) throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'Administrative access does not change participant read markers.');
    const messageId = asId(body.messageId);
    if (!db.prepare('SELECT 1 FROM messages WHERE id=? AND dm_id=?').get(messageId, access.dm.id)) throw new HttpError(400, 'INVALID_MESSAGE', 'That message is not in this DM.');
    db.prepare('UPDATE dm_participants SET last_read_message_id=? WHERE dm_id=? AND user_id=?').run(messageId, access.dm.id, user.id);
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/dms/:id/call-attempt', async ({ response, user, params }) => {
    const access = dmAccess(user, asId(params.id));
    if (access.admin) throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'Administrative access cannot initiate calls.');
    db.prepare('INSERT INTO voice_attempts(user_id,dm_id,created_at) VALUES (?,?,?)').run(user.id, access.dm.id, now());
    audit(db, config, 'voice.placeholder_opened', { actorId: user.id, dmId: access.dm.id, targetType: 'dm', targetId: access.dm.id });
    sendJson(response, 200, { available: false, title: 'Feature Under Construction!', message: 'Direct calling is not available yet, but it is planned for a future update.' });
  }, { auth: true });

  router.add('PUT', '/api/users/:id/block', async ({ response, user, params }) => {
    const blockedId = asId(params.id);
    if (!blockedId || blockedId === user.id || !db.prepare('SELECT 1 FROM users WHERE id=?').get(blockedId)) throw new HttpError(400, 'INVALID_USER', 'Choose another valid user.');
    db.prepare('INSERT OR IGNORE INTO dm_blocks(blocker_id,blocked_id,created_at) VALUES (?,?,?)').run(user.id, blockedId, now());
    audit(db, config, 'user.blocked', { actorId: user.id, targetType: 'user', targetId: blockedId });
    sendEmpty(response);
  }, { auth: true });

  router.add('DELETE', '/api/users/:id/block', async ({ response, user, params }) => {
    const blockedId = asId(params.id);
    db.prepare('DELETE FROM dm_blocks WHERE blocker_id=? AND blocked_id=?').run(user.id, blockedId);
    audit(db, config, 'user.unblocked', { actorId: user.id, targetType: 'user', targetId: blockedId });
    sendEmpty(response);
  }, { auth: true });

  // Optional Discovery directory and membership approval.
  router.add('GET', '/api/discovery', async ({ response, user, url }) => {
    const q = String(url.searchParams.get('q') ?? '').trim();
    const category = String(url.searchParams.get('category') ?? '').trim();
    const rows = db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM server_members WHERE server_id=s.id) member_count,
      EXISTS(SELECT 1 FROM server_members WHERE server_id=s.id AND user_id=?) joined
      FROM servers s WHERE s.discoverable=1 AND (?='' OR s.name LIKE ? OR s.description LIKE ? OR s.discovery_tags LIKE ?)
      AND (?='' OR s.discovery_category=?) ORDER BY member_count DESC,lower(s.name) LIMIT 100`)
      .all(user.id, q, `%${q}%`, `%${q}%`, `%${q}%`, category, category);
    sendJson(response, 200, { servers: rows.map((row) => ({ ...serializeServer(row), memberCount: row.member_count, joined: Boolean(row.joined) })) });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/join', async ({ response, user, params }) => {
    const server = getServer(asId(params.id));
    if (!server.discoverable) throw new HttpError(404, 'SERVER_NOT_DISCOVERABLE', 'This server is not listed in Discovery.');
    if (server.discovery_mode === 'invite') throw new HttpError(409, 'INVITE_REQUIRED', 'This server requires an invitation.');
    const ban = db.prepare('SELECT 1 FROM server_bans WHERE server_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)').get(server.id, user.id, now());
    if (ban) throw new HttpError(403, 'BANNED', 'You are banned from this server.');
    if (server.discovery_mode === 'approval') {
      db.prepare(`INSERT INTO membership_requests(server_id,user_id,status,created_at) VALUES (?,?,'pending',?)
        ON CONFLICT(server_id,user_id) DO UPDATE SET status='pending',created_at=excluded.created_at,decided_at=NULL,decided_by=NULL`).run(server.id, user.id, now());
      audit(db, config, 'member.requested', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: user.id });
      return sendJson(response, 202, { status: 'pending' });
    }
    db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(server.id, user.id, now());
    audit(db, config, 'member.joined', { actorId: user.id, serverId: server.id, targetType: 'user', targetId: user.id, payload: { source: 'discovery' } });
    broadcastServer(server.id, { type: 'member.joined', serverId: server.id, user: publicUser(user) });
    sendJson(response, 200, { status: 'joined', server: serializeServer(server) });
  }, { auth: true });

  router.add('GET', '/api/servers/:id/membership-requests', async ({ response, user, params }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.MANAGE_SERVER);
    const requests = db.prepare(`SELECT r.*,u.username,u.display_name,u.avatar_path,u.global_role,u.status,u.created_at user_created_at
      FROM membership_requests r JOIN users u ON u.id=r.user_id WHERE r.server_id=? AND r.status='pending' ORDER BY r.created_at`).all(serverId)
      .map((row) => ({ serverId, user: publicUser({ ...row, created_at: row.user_created_at }), createdAt: row.created_at }));
    sendJson(response, 200, { requests });
  }, { auth: true });

  router.add('POST', '/api/servers/:id/membership-requests/:userId', async ({ response, user, params, body }) => {
    const serverId = asId(params.id);
    const target = asId(params.userId);
    requirePermission(user, serverId, Permissions.MANAGE_SERVER);
    const decision = body.decision;
    if (!['approved', 'declined'].includes(decision)) throw new HttpError(400, 'INVALID_DECISION', 'Decision must be approved or declined.');
    const result = db.prepare("UPDATE membership_requests SET status=?,decided_at=?,decided_by=? WHERE server_id=? AND user_id=? AND status='pending'")
      .run(decision, now(), user.id, serverId, target);
    if (!result.changes) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Pending request not found.');
    if (decision === 'approved') db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES (?,?,?)').run(serverId, target, now());
    audit(db, config, `member.request_${decision}`, { actorId: user.id, serverId, targetType: 'user', targetId: target });
    sendEmpty(response);
  }, { auth: true });

  router.add('POST', '/api/reports', async ({ response, user, body }) => {
    const reason = requireText(body.reason, 'Reason', 3, 1000);
    const serverId = asId(body.serverId);
    const messageId = asId(body.messageId);
    if (!serverId && !messageId) throw new HttpError(400, 'REPORT_TARGET_REQUIRED', 'A server or message is required.');
    if (serverId) getServer(serverId);
    if (messageId) {
      const message = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      assertMessageScope(user, message);
    }
    const result = db.prepare('INSERT INTO reports(reporter_id,server_id,message_id,reason,created_at) VALUES (?,?,?,?,?)').run(user.id, serverId, messageId, reason, now());
    audit(db, config, 'report.created', { actorId: user.id, serverId, messageId, targetType: 'report', targetId: Number(result.lastInsertRowid), reason });
    sendJson(response, 201, { reportId: Number(result.lastInsertRowid) });
  }, { auth: true });

  // Server owners see only their server's logs; global admins use the explicit admin routes below.
  router.add('GET', '/api/servers/:id/logs', async ({ response, user, params, url }) => {
    const serverId = asId(params.id);
    requirePermission(user, serverId, Permissions.VIEW_AUDIT_LOG);
    const limit = pageLimit(url, 200);
    const before = boundedInteger(url.searchParams.get('before'), 'before', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const rows = db.prepare(`SELECT a.*,u.username actor_username,u.display_name actor_display_name FROM audit_logs a
      LEFT JOIN users u ON u.id=a.actor_id WHERE a.server_id=? AND a.id<? ORDER BY a.id DESC LIMIT ?`).all(serverId, before, limit).map(serializeAudit);
    audit(db, config, 'audit.server_viewed', { actorId: user.id, serverId, targetType: 'server', targetId: serverId, payload: { count: rows.length } });
    sendJson(response, 200, { logs: rows });
  }, { auth: true });

  // Platform administration.
  router.add('GET', '/api/admin/servers', async ({ response, user, url }) => {
    requireAdmin(user);
    const q = String(url.searchParams.get('q') ?? '').trim();
    const rows = db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM server_members WHERE server_id=s.id) member_count,
      (SELECT COUNT(*) FROM channels WHERE server_id=s.id) channel_count,
      (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.server_id=s.id) message_count
      FROM servers s WHERE (?='' OR s.name LIKE ? OR CAST(s.id AS TEXT)=?) ORDER BY s.is_system DESC,s.created_at DESC`)
      .all(q, `%${q}%`, q);
    audit(db, config, 'admin.server_directory_viewed', { actorId: user.id, targetType: 'platform', payload: { query: q, count: rows.length } });
    sendJson(response, 200, { servers: rows.map((row) => ({ ...serializeServer(row), memberCount: row.member_count, channelCount: row.channel_count, messageCount: row.message_count })) });
  }, { auth: true });

  router.add('GET', '/api/admin/users', async ({ response, user, url }) => {
    requireAdmin(user);
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
    const users = db.prepare(`SELECT * FROM users WHERE (?='' OR username_norm LIKE ? OR lower(display_name) LIKE ? OR CAST(id AS TEXT)=?)
      ORDER BY created_at DESC LIMIT 200`).all(q, `%${q}%`, `%${q}%`, q).map(publicUser);
    sendJson(response, 200, { users });
  }, { auth: true });

  router.add('PATCH', '/api/admin/users/:id/moderation', async ({ response, user, params, body }) => {
    requireAdmin(user);
    const targetId = asId(params.id);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(targetId);
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    if (targetId === user.id) throw new HttpError(409, 'SELF_MODERATION', 'Use another administrator account to moderate this account.');
    if (target.global_role === 'owner' && user.global_role !== 'owner') throw new HttpError(403, 'OWNER_PROTECTED', 'Only the platform owner can moderate the owner account.');
    const reason = requireText(body.reason, 'Reason', 3, 500);
    const action = body.action;
    let payload = {};
    if (!['suspend', 'unsuspend', 'mute', 'unmute'].includes(action)) throw new HttpError(400, 'INVALID_ACTION', 'Action must be suspend, unsuspend, mute, or unmute.');
    if (action === 'mute' && body.indefinite === true && body.durationMinutes !== undefined) throw new HttpError(400, 'INVALID_MUTE', 'Choose indefinite or a duration—not both.');
    transaction(db, () => {
      if (action === 'suspend') {
        const changedAt = now();
        db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(targetId);
        db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(changedAt, targetId);
        db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE admin_id=? AND closed_at IS NULL').run(changedAt, targetId);
      } else if (action === 'unsuspend') db.prepare("UPDATE users SET status='active' WHERE id=? AND status='suspended'").run(targetId);
      else if (action === 'mute') {
        const until = body.indefinite === true ? INDEFINITE_MUTE_UNTIL
          : now() + boundedInteger(body.durationMinutes, 'durationMinutes', 1, 525600, 10) * 60_000;
        db.prepare('UPDATE users SET muted_until=? WHERE id=?').run(until, targetId);
        payload = { until, indefinite: until === INDEFINITE_MUTE_UNTIL };
      } else db.prepare('UPDATE users SET muted_until=NULL WHERE id=?').run(targetId);
      audit(db, config, `admin.user_${action}`, { actorId: user.id, targetType: 'user', targetId, reason, payload });
    });
    broadcastUsers([targetId], { type: 'account.moderated', action, ...payload });
    if (action === 'suspend') for (const socket of sockets) if (socket.user.id === targetId) socket.close(4003, 'Account suspended');
    sendJson(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(targetId)) });
  }, { auth: true });

  router.add('PATCH', '/api/admin/users/:id/role', async ({ response, user, params, body }) => {
    if (user.global_role !== 'owner') throw new HttpError(403, 'OWNER_REQUIRED', 'Only the platform owner can change global administrator roles.');
    const targetId = asId(params.id);
    const role = body.role;
    if (!['user', 'admin'].includes(role)) throw new HttpError(400, 'INVALID_ROLE', 'Role must be user or admin.');
    if (targetId === user.id) throw new HttpError(409, 'OWNER_PROTECTED', 'The owner role cannot be changed here.');
    const target = db.prepare("SELECT * FROM users WHERE id=? AND status!='deleted' AND global_role!='owner'").get(targetId);
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    if (body.confirmUsername !== target.username) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact target username to confirm this role change.');
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    transaction(db, () => {
      db.prepare('UPDATE users SET global_role=? WHERE id=?').run(role, targetId);
      audit(db, config, 'admin.global_role_changed', { actorId: user.id, targetType: 'user', targetId, payload: { role, username: target.username } });
    });
    for (const socket of sockets) if (socket.user.id === targetId) socket.close(4001, 'Account role changed; reconnect');
    sendJson(response, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(targetId)) });
  }, { auth: true });

  router.add('POST', '/api/admin/owner/transfer', async ({ response, user, body }) => {
    if (user.global_role !== 'owner') throw new HttpError(403, 'OWNER_REQUIRED', 'Only the current platform owner can transfer ownership.');
    const targetId = asId(body.userId);
    if (!targetId || targetId === user.id) throw new HttpError(400, 'INVALID_TARGET', 'Choose another active account.');
    const target = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(targetId);
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'The target account is not active.');
    if (body.confirmUsername !== target.username) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact target username to confirm ownership transfer.');
    if (!(await verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    const existingOwners = db.prepare("SELECT id FROM users WHERE global_role='owner'").all();
    if (existingOwners.length !== 1 || Number(existingOwners[0].id) !== Number(user.id)) throw new HttpError(409, 'OWNER_STATE_INVALID', 'Platform ownership is not in a transferable state.');
    const changedAt = now();
    transaction(db, () => {
      audit(db, config, 'admin.owner_transferred', {
        actorId: user.id,
        targetType: 'user',
        targetId,
        payload: { previousOwnerId: user.id, previousOwnerUsername: user.username, newOwnerId: targetId, newOwnerUsername: target.username },
      });
      db.prepare(`UPDATE users SET global_role=CASE WHEN id=? THEN 'owner' WHEN id=? THEN 'admin' ELSE global_role END
        WHERE id IN (?,?)`).run(targetId, user.id, targetId, user.id);
      if (Number(db.prepare("SELECT COUNT(*) count FROM users WHERE global_role='owner'").get().count) !== 1) throw new Error('Ownership transfer did not produce exactly one owner.');
      db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE admin_id IN (?,?) AND closed_at IS NULL').run(changedAt, user.id, targetId);
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id IN (?,?) AND revoked_at IS NULL').run(changedAt, user.id, targetId);
    });
    for (const socket of sockets) if (socket.user.id === user.id || socket.user.id === targetId) socket.close(4001, 'Platform ownership changed; sign in again');
    sendJson(response, 200, { transferred: true, newOwner: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(targetId)), signedOut: true });
  }, { auth: true });

  router.add('GET', '/api/admin/dms', async ({ response, user, url }) => {
    requireAdmin(user);
    const targetId = asId(url.searchParams.get('userId'));
    if (!targetId) throw new HttpError(400, 'USER_REQUIRED', 'userId is required.');
    const conversations = db.prepare(`SELECT d.id,d.created_at,(SELECT MAX(created_at) FROM messages WHERE dm_id=d.id) last_message_at,
      (SELECT COUNT(*) FROM messages WHERE dm_id=d.id) message_count FROM dm_conversations d
      WHERE EXISTS(SELECT 1 FROM dm_participants p WHERE p.dm_id=d.id AND p.user_id=?) ORDER BY COALESCE(last_message_at,d.created_at) DESC`).all(targetId)
      .map((row) => ({ ...row, participants: db.prepare('SELECT u.id,u.username,u.display_name FROM dm_participants p JOIN users u ON u.id=p.user_id WHERE p.dm_id=?').all(row.id) }));
    audit(db, config, 'admin.dm_directory_searched', { actorId: user.id, targetType: 'user', targetId, payload: { count: conversations.length } });
    sendJson(response, 200, { conversations });
  }, { auth: true });

  router.add('POST', '/api/admin/dms/:id/open', async ({ response, user, params, body }) => {
    requireAdmin(user);
    const dmId = asId(params.id);
    if (!db.prepare('SELECT 1 FROM dm_conversations WHERE id=?').get(dmId)) throw new HttpError(404, 'DM_NOT_FOUND', 'Direct-message conversation not found.');
    const reason = requireText(body.reason, 'Access reason', 5, 500);
    const opened = now();
    const accessId = transaction(db, () => {
      db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE admin_id=? AND session_id=? AND dm_id=? AND closed_at IS NULL').run(opened, user.id, user.session_id, dmId);
      const result = db.prepare('INSERT INTO admin_dm_access(dm_id,admin_id,session_id,reason,opened_at,last_access_at) VALUES (?,?,?,?,?,?)')
        .run(dmId, user.id, user.session_id, reason, opened, opened);
      audit(db, config, 'admin.dm_opened', { actorId: user.id, dmId, targetType: 'dm', targetId: dmId, reason, payload: { sessionId: user.session_id } });
      return Number(result.lastInsertRowid);
    });
    sendJson(response, 200, { accessId, dmId, openedAt: opened, expiresAfterIdleMinutes: 60, banner: 'Administrative access is active and every action is logged.' });
  }, { auth: true });

  router.add('POST', '/api/admin/dms/:id/close', async ({ response, user, params }) => {
    requireAdmin(user);
    const dmId = asId(params.id);
    transaction(db, () => {
      db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE admin_id=? AND session_id=? AND dm_id=? AND closed_at IS NULL').run(now(), user.id, user.session_id, dmId);
      audit(db, config, 'admin.dm_closed', { actorId: user.id, dmId, targetType: 'dm', targetId: dmId, payload: { sessionId: user.session_id } });
    });
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/admin/logs', async ({ response, user, url }) => {
    requireAdmin(user);
    const limit = pageLimit(url, 500);
    const before = boundedInteger(url.searchParams.get('before'), 'before', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const serverId = asId(url.searchParams.get('serverId'));
    const dmId = asId(url.searchParams.get('dmId'));
    const event = String(url.searchParams.get('event') ?? '').trim();
    if (dmId && !db.prepare(`SELECT 1 FROM admin_dm_access WHERE dm_id=? AND admin_id=? AND session_id=?
      AND closed_at IS NULL AND last_access_at>?`).get(dmId, user.id, user.session_id, now() - 3_600_000)) {
      throw new HttpError(403, 'DM_ACCESS_REQUIRED', 'Open an audited administration session before reading DM logs.');
    }
    const rows = db.prepare(`SELECT a.*,u.username actor_username,u.display_name actor_display_name FROM audit_logs a
      LEFT JOIN users u ON u.id=a.actor_id WHERE a.id<? AND (? IS NULL OR a.server_id=?) AND
      ((? IS NULL AND a.dm_id IS NULL) OR a.dm_id=?)
      AND (?='' OR a.event_type=?) ORDER BY a.id DESC LIMIT ?`).all(before, serverId, serverId, dmId, dmId, event, event, limit).map(serializeAudit);
    audit(db, config, 'admin.logs_viewed', { actorId: user.id, serverId, dmId, targetType: 'audit', payload: { count: rows.length, event } });
    sendJson(response, 200, { logs: rows, retentionDays: config.logRetentionDays });
  }, { auth: true });

  router.add('GET', '/api/admin/logs/expiring', async ({ response, user, url }) => {
    requireAdmin(user);
    const days = boundedInteger(url.searchParams.get('days'), 'days', 1, 30, 5);
    const end = now() + days * 86_400_000;
    const summary = db.prepare(`SELECT event_type,COUNT(*) count,MIN(expires_at) first_expiry,MAX(expires_at) last_expiry
      FROM audit_logs WHERE expires_at>? AND expires_at<=? GROUP BY event_type ORDER BY count DESC`).all(now(), end);
    const total = summary.reduce((sum, row) => sum + Number(row.count), 0);
    sendJson(response, 200, { days, total, summary });
  }, { auth: true });

  router.add('POST', '/api/admin/logs/export', async ({ response, user, body }) => {
    requireAdmin(user);
    const password = requireText(body.password, 'Export password', 12, 256);
    if (!(await verifyPassword(password, user.password_salt, user.password_hash))) throw new HttpError(401, 'INVALID_PASSWORD', 'Password is incorrect.');
    const from = boundedInteger(body.from, 'from', 0, Number.MAX_SAFE_INTEGER, 0);
    const to = boundedInteger(body.to, 'to', 1, Number.MAX_SAFE_INTEGER, now() + 5 * 86_400_000);
    if (from > to) throw new HttpError(400, 'INVALID_RANGE', 'The export start time must be before its end time.');
    const serverId = asId(body.serverId);
    const dmId = asId(body.dmId);
    let dmReason = null;
    if (dmId) {
      const access = db.prepare(`SELECT * FROM admin_dm_access WHERE dm_id=? AND admin_id=? AND session_id=?
        AND closed_at IS NULL AND last_access_at>? ORDER BY opened_at DESC LIMIT 1`)
        .get(dmId, user.id, user.session_id, now() - 3_600_000);
      if (!access) throw new HttpError(403, 'DM_ACCESS_REQUIRED', 'Open an audited administration session before exporting DM logs.');
      dmReason = access.reason;
    }
    const rows = db.prepare(`SELECT * FROM audit_logs WHERE created_at>=? AND created_at<=? AND
      (? IS NULL OR server_id=?) AND ((? IS NULL AND dm_id IS NULL) OR dm_id=?) ORDER BY id LIMIT ?`)
      .all(from, to, serverId, serverId, dmId, dmId, MAX_AUDIT_EXPORT_RECORDS + 1);
    if (rows.length > MAX_AUDIT_EXPORT_RECORDS) throw new HttpError(413, 'EXPORT_TOO_LARGE', 'This export contains more than 10,000 records. Narrow the from/to range and try again.');
    const serializedRows = rows.map((row) => ({ ...row, payload: json(row.payload) }));
    const cleartext = Buffer.from(JSON.stringify({ format: 'babcord-audit-v1', exportedAt: now(), from, to, records: serializedRows }));
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const output = Buffer.concat([Buffer.from('BABCORD1'), salt, iv, tag, encrypted]);
    const filename = `babcord-logs-${new Date().toISOString().slice(0, 10)}.bclog`;
    writeFileSync(resolve(config.exportDir, filename), output, { flag: 'w' });
    audit(db, config, 'admin.logs_exported', { actorId: user.id, serverId, dmId, targetType: 'audit', reason: dmReason, payload: { from, to, records: serializedRows.length, filename } });
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDisposition(filename), 'Content-Length': output.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    response.end(output);
  }, { auth: true });

  router.add('GET', '/api/admin/notifications', async ({ response, user }) => {
    requireAdmin(user);
    const rows = db.prepare('SELECT * FROM admin_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id).map((row) => ({ ...row, payload: json(row.payload), read: Boolean(row.read_at) }));
    sendJson(response, 200, { notifications: rows });
  }, { auth: true });

  router.add('POST', '/api/admin/notifications/:id/read', async ({ response, user, params }) => {
    requireAdmin(user);
    db.prepare('UPDATE admin_notifications SET read_at=? WHERE id=? AND user_id=?').run(now(), asId(params.id), user.id);
    sendEmpty(response);
  }, { auth: true });

  router.add('GET', '/api/admin/reports', async ({ response, user }) => {
    requireAdmin(user);
    sendJson(response, 200, { reports: db.prepare('SELECT * FROM reports ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'reviewing\' THEN 1 ELSE 2 END,created_at DESC LIMIT 500').all() });
  }, { auth: true });

  router.add('GET', '/api/admin/stats', async ({ response, user }) => {
    requireAdmin(user);
    const stats = {
      users: Number(db.prepare("SELECT COUNT(*) count FROM users WHERE status!='deleted'").get().count),
      onlineUsers: new Set([...sockets].map((socket) => socket.user.id)).size,
      servers: Number(db.prepare('SELECT COUNT(*) count FROM servers').get().count),
      messages: Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count),
      attachmentsBytes: Number(db.prepare('SELECT COALESCE(SUM(size),0) total FROM attachments').get().total),
      openReports: Number(db.prepare("SELECT COUNT(*) count FROM reports WHERE status IN ('open','reviewing')").get().count),
      voiceChannelAttempts: Number(db.prepare('SELECT COUNT(*) count FROM voice_attempts WHERE channel_id IS NOT NULL').get().count),
      directCallAttempts: Number(db.prepare('SELECT COUNT(*) count FROM voice_attempts WHERE dm_id IS NOT NULL').get().count),
    };
    sendJson(response, 200, { stats });
  }, { auth: true });

  router.add('PATCH', '/api/admin/reports/:id', async ({ response, user, params, body }) => {
    requireAdmin(user);
    const status = body.status;
    if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) throw new HttpError(400, 'INVALID_STATUS', 'Invalid report status.');
    const result = db.prepare('UPDATE reports SET status=?,resolved_at=?,resolved_by=? WHERE id=?').run(status, ['resolved', 'dismissed'].includes(status) ? now() : null, ['resolved', 'dismissed'].includes(status) ? user.id : null, asId(params.id));
    if (!result.changes) throw new HttpError(404, 'REPORT_NOT_FOUND', 'Report not found.');
    audit(db, config, 'admin.report_updated', { actorId: user.id, targetType: 'report', targetId: asId(params.id), payload: { status } });
    sendEmpty(response);
  }, { auth: true });

  router.add('PUT', '/api/me/avatar', async ({ response, user, body }) => {
    const attachment = db.prepare("SELECT * FROM attachments WHERE id=? AND uploader_id=? AND message_id IS NULL AND purpose='message'").get(asId(body.attachmentId), user.id);
    if (!attachment || !isImageType(attachment.content_type) || attachment.size > 2 * 1024 * 1024) throw new HttpError(400, 'INVALID_AVATAR', 'Choose an uploaded PNG, JPEG, GIF, or WebP image no larger than 2 MB.');
    transaction(db, () => {
      if (user.avatar_path) db.prepare("UPDATE attachments SET deleted_at=? WHERE stored_name=? AND purpose='avatar'").run(now(), user.avatar_path);
      db.prepare("UPDATE attachments SET purpose='avatar' WHERE id=?").run(attachment.id);
      db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(attachment.stored_name, user.id);
    });
    audit(db, config, 'account.avatar_updated', { actorId: user.id, targetType: 'user', targetId: user.id, payload: { attachmentId: attachment.id } });
    sendJson(response, 200, { avatarUrl: `/api/users/${user.id}/avatar` });
  }, { auth: true });

  router.add('GET', '/api/users/:id/avatar', async ({ response, user, params }) => {
    const target = db.prepare('SELECT avatar_path FROM users WHERE id=?').get(asId(params.id));
    if (!target?.avatar_path) throw new HttpError(404, 'AVATAR_NOT_FOUND', 'Avatar not found.');
    const attachment = db.prepare("SELECT * FROM attachments WHERE stored_name=? AND purpose='avatar'").get(target.avatar_path);
    if (!attachment || !serveFile(response, config.attachmentDir, attachment.stored_name, { 'Content-Type': attachment.content_type, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' })) throw new HttpError(404, 'AVATAR_NOT_FOUND', 'Avatar not found.');
  }, { auth: true });

  router.add('PUT', '/api/servers/:id/icon', async ({ response, user, params, body }) => {
    const server = getServer(asId(params.id));
    requirePermission(user, server.id, Permissions.MANAGE_SERVER);
    const attachment = db.prepare("SELECT * FROM attachments WHERE id=? AND uploader_id=? AND message_id IS NULL AND purpose='message'").get(asId(body.attachmentId), user.id);
    if (!attachment || !isImageType(attachment.content_type) || attachment.size > 2 * 1024 * 1024) throw new HttpError(400, 'INVALID_ICON', 'Choose an uploaded PNG, JPEG, GIF, or WebP image no larger than 2 MB.');
    transaction(db, () => {
      if (server.icon_path) db.prepare("UPDATE attachments SET deleted_at=? WHERE stored_name=? AND purpose='server_icon'").run(now(), server.icon_path);
      db.prepare("UPDATE attachments SET purpose='server_icon' WHERE id=?").run(attachment.id);
      db.prepare('UPDATE servers SET icon_path=? WHERE id=?').run(attachment.stored_name, server.id);
    });
    audit(db, config, 'server.icon_updated', { actorId: user.id, serverId: server.id, targetType: 'server', targetId: server.id, payload: { attachmentId: attachment.id } });
    sendJson(response, 200, { iconUrl: `/api/servers/${server.id}/icon` });
  }, { auth: true });

  router.add('GET', '/api/servers/:id/icon', async ({ response, user, params }) => {
    const server = getServer(asId(params.id));
    if (!server.icon_path) throw new HttpError(404, 'ICON_NOT_FOUND', 'Server icon not found.');
    if (!server.discoverable && !serverPermissions(db, user, server.id)) throw new HttpError(403, 'NOT_A_MEMBER', 'You cannot view this server icon.');
    const attachment = db.prepare("SELECT * FROM attachments WHERE stored_name=? AND purpose='server_icon'").get(server.icon_path);
    if (!attachment || !serveFile(response, config.attachmentDir, attachment.stored_name, { 'Content-Type': attachment.content_type, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' })) throw new HttpError(404, 'ICON_NOT_FOUND', 'Server icon not found.');
  }, { auth: true });

  router.add('POST', '/api/realtime-ticket', async ({ response, user }) => {
    const count = [...sockets].filter((socket) => socket.user.id === user.id).length;
    const timestamp = now();
    let pending = 0;
    for (const [hash, ticketInfo] of realtimeTickets) {
      if (ticketInfo.expiresAt <= timestamp) realtimeTickets.delete(hash);
      else if (Number(ticketInfo.userId) === Number(user.id)) pending += 1;
    }
    if (count + pending >= 5) throw new HttpError(429, 'SOCKET_LIMIT', 'This account already has five realtime connections or pending tickets.');
    const ticket = randomToken(24);
    realtimeTickets.set(tokenHash(ticket), { userId: user.id, sessionId: user.session_id, expiresAt: now() + 30_000 });
    sendJson(response, 201, { ticket, url: `${config.publicUrl.replace(/^http/, 'ws')}/realtime?ticket=${encodeURIComponent(ticket)}`, expiresInSeconds: 30 });
  }, { auth: true });

  function sharedUserIds(userId) {
    return db.prepare(`SELECT DISTINCT other_id FROM (
      SELECT m2.user_id other_id FROM server_members m1 JOIN server_members m2 ON m2.server_id=m1.server_id WHERE m1.user_id=?
      UNION SELECT p2.user_id other_id FROM dm_participants p1 JOIN dm_participants p2 ON p2.dm_id=p1.dm_id WHERE p1.user_id=?
    )`).all(userId, userId).map((row) => Number(row.other_id));
  }

  function publishPresence(userId, status) {
    broadcastUsers(sharedUserIds(userId), { type: 'presence.updated', userId, status, presence: status });
  }

  function runMaintenance(forceWarnings = false) {
    const timestamp = now();
    const cutoff = timestamp - config.logRetentionDays * 86_400_000;
    db.prepare('DELETE FROM server_bans WHERE expires_at IS NOT NULL AND expires_at<=?').run(timestamp);
    db.prepare('UPDATE admin_dm_access SET closed_at=? WHERE closed_at IS NULL AND last_access_at<?').run(timestamp, timestamp - 3_600_000);
    db.prepare('DELETE FROM sessions WHERE expires_at<? OR (revoked_at IS NOT NULL AND revoked_at<?)').run(cutoff, cutoff);

    const currentHour = new Date().getHours();
    if (forceWarnings || currentHour >= Math.min(config.logWarningHour, 23)) {
      const warningEnd = timestamp + config.logWarningDays * 86_400_000;
      const count = Number(db.prepare('SELECT COUNT(*) count FROM audit_logs WHERE expires_at>? AND expires_at<=?').get(timestamp, warningEnd).count);
      if (count) {
        const day = new Date().toISOString().slice(0, 10);
        const first = db.prepare('SELECT MIN(expires_at) value FROM audit_logs WHERE expires_at>? AND expires_at<=?').get(timestamp, warningEnd).value;
        const admins = db.prepare("SELECT id FROM users WHERE global_role IN ('admin','owner') AND status='active'").all();
        const insert = db.prepare(`INSERT OR IGNORE INTO admin_notifications(user_id,type,title,body,payload,dedupe_key,created_at)
          VALUES (?,'log_expiration',?,?,?,?,?)`);
        for (const admin of admins) insert.run(admin.id, 'Log expiration warning', `${count.toLocaleString()} audit records will be permanently purged within ${config.logWarningDays} days. Export them first if they must be retained.`, JSON.stringify({ count, warningDays: config.logWarningDays, firstExpiry: first }), `log-expiry:${day}`, timestamp);
      }
    }

    // Deleted message payloads survive in audit_logs until their individual expires_at timestamps.
    db.prepare('DELETE FROM audit_logs WHERE expires_at<=?').run(timestamp);
    db.prepare('DELETE FROM message_edits WHERE created_at<?').run(cutoff);
    db.prepare('DELETE FROM voice_attempts WHERE created_at<?').run(cutoff);
    db.prepare('DELETE FROM admin_dm_access WHERE opened_at<?').run(cutoff);
    db.prepare('DELETE FROM admin_notifications WHERE created_at<?').run(timestamp - 90 * 86_400_000);

    const expiredFiles = db.prepare(`SELECT id,stored_name FROM attachments WHERE
      (deleted_at IS NOT NULL AND deleted_at<?) OR (deleted_at IS NULL AND message_id IS NULL AND purpose='message' AND created_at<?)`).all(cutoff, timestamp - 86_400_000);
    for (const file of expiredFiles) {
      try { unlinkSync(resolve(config.attachmentDir, file.stored_name)); } catch {}
      db.prepare('DELETE FROM attachments WHERE id=?').run(file.id);
    }
    return { purgedBefore: cutoff, expiredFiles: expiredFiles.length };
  }

  router.add('POST', '/api/admin/maintenance', async ({ response, user }) => {
    requireAdmin(user);
    const result = runMaintenance(true);
    audit(db, config, 'admin.maintenance_run', { actorId: user.id, targetType: 'platform', payload: result });
    sendJson(response, 200, result);
  }, { auth: true });

  const server = http.createServer(async (request, response) => {
    const headers = corsHeaders(request);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      const origin = request.headers.origin;
      if (origin && !originAllowed(origin)) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This request origin is not allowed.');
      if (request.method === 'OPTIONS') return sendEmpty(response, 204);

      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(302, { Location: '/client/' });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/client/download') {
        if (serveFile(response, config.clientDir, 'Open Babcord.html', {
          'Cache-Control': 'no-cache',
          'Content-Disposition': contentDisposition('Open Babcord.html'),
        })) return;
        throw new HttpError(404, 'CLIENT_FILE_NOT_FOUND', 'Client launcher not found.');
      }
      if (request.method === 'GET' && (url.pathname === '/client' || url.pathname.startsWith('/client/')) && url.pathname !== '/client/manifest.json') {
        const encodedRelative = url.pathname === '/client' || url.pathname === '/client/' ? 'index.html' : url.pathname.slice('/client/'.length);
        let relative;
        try { relative = decodeURIComponent(encodedRelative); }
        catch { throw new HttpError(400, 'INVALID_CLIENT_PATH', 'Client file path is not valid URL encoding.'); }
        if (serveFile(response, config.clientDir, relative, { 'Cache-Control': 'no-cache' })) return;
        throw new HttpError(404, 'CLIENT_FILE_NOT_FOUND', 'Client file not found.');
      }

      const match = router.match(request.method, url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found.');
      const user = match.options.auth ? getSession(request) : null;
      if (match.options.auth && !user) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      if (user) limiter.check('api', user.id, 120, 60_000);
      const body = match.options.raw || ['GET', 'HEAD'].includes(request.method) ? {} : await readJson(request);
      await match.handler({ request, response, url, params: match.params, body, user });
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        if (error.details?.retryAfter) response.setHeader('Retry-After', String(error.details.retryAfter));
        return sendJson(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      }
      console.error('Unhandled request error:', error);
      sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'The server could not complete the request.' } });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/realtime' || !originAllowed(request.headers.origin)) throw new Error('Rejected');
      const ticketHash = tokenHash(url.searchParams.get('ticket') ?? '');
      const ticket = realtimeTickets.get(ticketHash);
      realtimeTickets.delete(ticketHash);
      if (!ticket || ticket.expiresAt < now()) throw new Error('Rejected');
      if ([...sockets].filter((item) => Number(item.user.id) === Number(ticket.userId)).length >= 5) throw new Error('Rejected');
      const user = db.prepare(`SELECT s.id session_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`)
        .get(ticket.sessionId, ticket.userId, now());
      if (!user) throw new Error('Rejected');
      wss.handleUpgrade(request, socket, head, (websocket) => {
        websocket.user = user;
        websocket.dmSubscriptions = new Set();
        websocket.isAlive = true;
        wss.emit('connection', websocket, request);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (socket) => {
    sockets.add(socket);
    const online = [...new Set([...sockets].map((item) => item.user.id))];
    sendTo(socket, { type: 'hello', user: publicUser(socket.user), onlineUserIds: online, serverTime: now() });
    publishPresence(socket.user.id, 'online');
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      try {
        const currentUser = db.prepare(`SELECT s.id session_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`)
          .get(socket.user.session_id, socket.user.id, now());
        if (!currentUser) return socket.close(4003, 'Account unavailable');
        socket.user = currentUser;
        const event = JSON.parse(raw.toString());
        limiter.check('ws-event', socket.user.id, 40, 10_000);
        if (event.type === 'ping') return sendTo(socket, { type: 'pong', serverTime: now() });
        if (event.type === 'subscribe.dm') {
          const access = dmAccess(socket.user, asId(event.dmId), true);
          socket.dmSubscriptions.add(access.dm.id);
          if (access.admin) audit(db, config, 'admin.dm_realtime_subscribed', { actorId: socket.user.id, dmId: access.dm.id, targetType: 'dm', targetId: access.dm.id, reason: access.access.reason });
          return sendTo(socket, { type: 'subscribed.dm', dmId: access.dm.id });
        }
        if (event.type === 'unsubscribe.dm') {
          socket.dmSubscriptions.delete(asId(event.dmId));
          return;
        }
        if (event.type === 'typing' || event.type === 'typing.start' || event.type === 'typing.stop') {
          const active = event.type === 'typing.stop' ? false : event.active !== false;
          if (event.channelId) {
            const channel = getChannel(asId(event.channelId));
            requirePermission(socket.user, channel.server_id, Permissions.SEND_MESSAGES, channel.id);
            assertParticipationAllowed(socket.user, channel.server_id);
            return broadcastChannel(channel.server_id, channel.id, { type: 'typing', channelId: channel.id, userId: socket.user.id, user: publicUser(socket.user), active });
          }
          if (event.dmId) {
            assertParticipationAllowed(socket.user);
            const access = dmAccess(socket.user, asId(event.dmId));
            if (access.admin) throw new HttpError(403, 'PARTICIPANT_REQUIRED', 'Administrative access does not send typing status.');
            return broadcastDm(access.dm.id, { type: 'typing', dmId: access.dm.id, userId: socket.user.id, user: publicUser(socket.user), active });
          }
        }
        if (event.type === 'presence') {
          const status = ['online', 'idle', 'offline'].includes(event.status) ? event.status : 'online';
          socket.presence = status;
          publishPresence(socket.user.id, status);
        }
      } catch (error) {
        sendTo(socket, { type: 'error', code: error.code ?? 'INVALID_EVENT', message: error instanceof HttpError ? error.message : 'Invalid realtime event.' });
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (![...sockets].some((item) => item.user.id === socket.user.id)) publishPresence(socket.user.id, 'offline');
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
    const timestamp = now();
    for (const [key, value] of realtimeTickets) if (value.expiresAt < timestamp) realtimeTickets.delete(key);
  }, 30_000);
  heartbeat.unref();

  return {
    db,
    config,
    seed,
    httpServer: server,
    runMaintenance,
    async start() {
      runMaintenance(true);
      maintenanceTimer = setInterval(() => runMaintenance(false), 3_600_000);
      maintenanceTimer.unref();
      await new Promise((resolveStart, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolveStart(); });
      });
      return server.address();
    },
    async stop() {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      clearInterval(heartbeat);
      for (const socket of sockets) socket.close(1001, 'Server shutting down');
      await new Promise((resolveStop) => wss.close(() => resolveStop()));
      if (server.listening) await new Promise((resolveStop) => server.close(() => resolveStop()));
      db.close();
    },
  };
}
