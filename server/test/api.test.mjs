import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createBabcordServer } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { Permissions } from '../src/permissions.mjs';

function testConfig(dataDir, overrides = {}) {
  return loadConfig({
    dataDir,
    secret: 'test-session-secret-not-for-production',
    recoverySecret: 'test-recovery-secret-not-for-production',
    adminUsername: 'TestOwner',
    adminPassword: 'owner-password-123',
    clientDir: join(import.meta.dirname, '..', '..', 'client'),
    port: 0,
    testing: true,
    ...overrides,
  });
}

async function fixture(callback, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'babcord-test-'));
  const app = await createBabcordServer(testConfig(dataDir, overrides));
  const address = await app.start();
  const base = `http://127.0.0.1:${address.port}`;
  let stopped = false;

  async function api(path, { token, body, headers = {}, ...options } = {}) {
    const requestHeaders = { Origin: 'null', ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined && !Buffer.isBuffer(body)) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + path, {
      ...options,
      headers: requestHeaders,
      body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const value = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, value };
  }

  async function register(username) {
    const result = await api('/api/auth/register', { method: 'POST', body: { username, password: 'correct-horse-battery' } });
    assert.equal(result.response.status, 201, JSON.stringify(result.value));
    return result.value;
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };

  try { await callback({ app, base, api, register, dataDir, stop }); }
  finally {
    await stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}

async function openRealtime(base, api, token) {
  const ticketResult = await api('/api/realtime-ticket', { token, method: 'POST', body: {} });
  assert.equal(ticketResult.response.status, 201, JSON.stringify(ticketResult.value));
  const websocket = new WebSocket(`${base.replace('http:', 'ws:')}/realtime?ticket=${encodeURIComponent(ticketResult.value.ticket)}`, { origin: 'null' });
  const events = [];
  websocket.on('message', (data) => events.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
  await waitFor(() => events.some((event) => event.type === 'hello'), 'Realtime hello was not received.');
  return { websocket, events };
}

async function closeRealtime(...connections) {
  await Promise.all(connections.map(({ websocket }) => new Promise((resolve) => {
    if (websocket.readyState === WebSocket.CLOSED) return resolve();
    websocket.once('close', resolve);
    websocket.close();
  })));
}

test('registration permits school onboarding while retaining a configurable shared-IP guard', async () => {
  const defaultDataDir = mkdtempSync(join(tmpdir(), 'babcord-config-test-'));
  try {
    assert.equal(loadConfig({ dataDir: defaultDataDir, secret: 'test', adminUsername: 'owner', adminPassword: 'owner-password-123' }).registrationRateLimitPerHour, 30);
  } finally {
    rmSync(defaultDataDir, { recursive: true, force: true });
  }

  await fixture(async ({ api, register }) => {
    await register('rate.one');
    const limited = await api('/api/auth/register', { method: 'POST', body: { username: 'rate.two', password: 'correct-horse-battery' } });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.value.error.code, 'RATE_LIMITED');
  }, { registrationRateLimitPerHour: 1 });
});

test('file-origin CORS, account recovery, sessions, and mandatory server work', async () => fixture(async ({ api, register }) => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('access-control-allow-origin'), 'null');
  assert.equal(health.value.status, 'online');
  const clientConfig = await api('/client/config.js');
  assert.equal(clientConfig.response.status, 200);
  assert.match(clientConfig.value.toString(), /apiBaseUrl/);
  assert.match(clientConfig.value.toString(), /storageKeys/);
  assert.equal(clientConfig.response.headers.get('cache-control'), 'no-cache');
  const manifest = await api('/client/manifest.json');
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.value.downloadUrl, 'https://babcord.withermask.net/client/Open%20Babcord.html');
  const launcher = await api('/client/Open%20Babcord.html');
  assert.equal(launcher.response.status, 200);
  assert.match(launcher.value.toString(), /<title>Open Babcord<\/title>/);
  const launcherDownload = await api('/client/download');
  assert.equal(launcherDownload.response.status, 200);
  assert.match(launcherDownload.response.headers.get('content-disposition'), /^attachment;/);

  const alice = await register('alice.test');
  assert.equal(alice.recoveryCodes.length, 8);
  const me = await api('/api/me', { token: alice.token });
  assert.equal(me.response.status, 200);
  assert.equal(me.value.servers.length, 1);
  assert.equal(me.value.servers[0].mandatory, true);

  const recovered = await api('/api/auth/recover', {
    method: 'POST',
    body: { username: 'ALICE.TEST', recoveryCode: alice.recoveryCodes[0], newPassword: 'brand-new-password' },
  });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.value));
  const oldSession = await api('/api/me', { token: alice.token });
  assert.equal(oldSession.response.status, 401);
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'alice.test', password: 'brand-new-password' } });
  assert.equal(login.response.status, 200);
}));

test('account deletion removes mandatory membership permanently across restart', async () => fixture(async ({ app, api, register, dataDir, stop }) => {
  const alice = await register('alice.delete-restart');
  const mandatoryId = app.db.prepare('SELECT id FROM servers WHERE is_system=1').get().id;
  assert.equal(app.db.prepare('SELECT COUNT(*) count FROM server_members WHERE server_id=? AND user_id=?').get(mandatoryId, alice.user.id).count, 1);
  const deleted = await api('/api/me', { token: alice.token, method: 'DELETE', body: { password: 'correct-horse-battery' } });
  assert.equal(deleted.response.status, 204);
  assert.equal(app.db.prepare('SELECT COUNT(*) count FROM server_members WHERE user_id=?').get(alice.user.id).count, 0);
  await stop();

  const restarted = await createBabcordServer(testConfig(dataDir));
  await restarted.start();
  try {
    assert.equal(restarted.db.prepare('SELECT status FROM users WHERE id=?').get(alice.user.id).status, 'deleted');
    assert.equal(restarted.db.prepare('SELECT COUNT(*) count FROM server_members WHERE user_id=?').get(alice.user.id).count, 0);
  } finally {
    await restarted.stop();
  }
}));

test('image filename extensions cannot bypass the image byte limit with a generic MIME type', async () => fixture(async ({ api, register }) => {
  const alice = await register('alice.upload-limit');
  let result = await api('/api/uploads?filename=oversized.png', {
    token: alice.token,
    method: 'POST',
    body: Buffer.alloc(5),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(result.response.status, 413);
  assert.equal(result.value.error.code, 'PAYLOAD_TOO_LARGE');

  result = await api('/api/uploads?filename=allowed.txt', {
    token: alice.token,
    method: 'POST',
    body: Buffer.alloc(5),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
}, { maxImageBytes: 4, maxFileBytes: 10 }));

test('only live unbound message uploads can be attached or downloaded', async () => fixture(async ({ app, api, register }) => {
  const alice = await register('alice.attachment-state');
  let result = await api('/api/servers', { token: alice.token, method: 'POST', body: { name: 'Attachment State' } });
  const serverId = result.value.server.id;
  result = await api(`/api/servers/${serverId}`, { token: alice.token });
  const channelId = result.value.channels.find((channel) => channel.type === 'text').id;

  result = await api('/api/uploads?filename=avatar.png', { token: alice.token, method: 'POST', body: Buffer.from('image'), headers: { 'Content-Type': 'image/png' } });
  const avatarAttachmentId = result.value.attachment.id;
  result = await api('/api/me/avatar', { token: alice.token, method: 'PUT', body: { attachmentId: avatarAttachmentId } });
  assert.equal(result.response.status, 200);
  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { attachmentIds: [avatarAttachmentId] } });
  assert.equal(result.response.status, 400);
  assert.equal(result.value.error.code, 'INVALID_ATTACHMENT');

  result = await api('/api/uploads?filename=deleted.txt', { token: alice.token, method: 'POST', body: Buffer.from('deleted') });
  const deletedAttachmentId = result.value.attachment.id;
  app.db.prepare('UPDATE attachments SET deleted_at=? WHERE id=?').run(Date.now(), deletedAttachmentId);
  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { attachmentIds: [deletedAttachmentId] } });
  assert.equal(result.response.status, 400);
  result = await api(`/api/attachments/${deletedAttachmentId}`, { token: alice.token });
  assert.equal(result.response.status, 404);

  result = await api('/api/uploads?filename=container.txt', { token: alice.token, method: 'POST', body: Buffer.from('container-deleted') });
  const containerAttachmentId = result.value.attachment.id;
  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Will be deleted with channel', attachmentIds: [containerAttachmentId] } });
  assert.equal(result.response.status, 201);
  result = await api(`/api/channels/${channelId}`, { token: alice.token, method: 'DELETE' });
  assert.equal(result.response.status, 204);
  result = await api(`/api/attachments/${containerAttachmentId}`, { token: alice.token });
  assert.equal(result.response.status, 404);
}));

test('servers, discovery, messages, edits, deletion logs, reactions, and unfiltered HTML bytes work', async () => fixture(async ({ app, api, register }) => {
  const alice = await register('alice.chat');
  const bob = await register('bob.chat');
  let result = await api('/api/servers', { token: alice.token, method: 'POST', body: { name: 'Study Hall' } });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
  const serverId = result.value.server.id;

  result = await api(`/api/servers/${serverId}`, { token: alice.token, method: 'PATCH', body: { discoverable: true, discoveryMode: 'public', discoveryTags: ['school'] } });
  assert.equal(result.response.status, 200);
  result = await api('/api/discovery?q=Study', { token: bob.token });
  assert.equal(result.value.servers[0].id, serverId);
  result = await api(`/api/servers/${serverId}/join`, { token: bob.token, method: 'POST', body: {} });
  assert.equal(result.response.status, 200);

  result = await api(`/api/servers/${serverId}`, { token: alice.token });
  const channelId = result.value.channels.find((channel) => channel.type === 'text').id;
  result = await api(`/api/channels/${channelId}`, { token: alice.token, method: 'PATCH', body: { topic: 'Homework help and project planning' } });
  assert.equal(result.value.channel.topic, 'Homework help and project planning');
  result = await api(`/api/servers/${serverId}`, { token: alice.token });
  assert.equal(result.value.channels.find((channel) => channel.id === channelId).topic, 'Homework help and project planning');
  const html = Buffer.from('<html><script>alert("unchanged")</script></html>');
  result = await api('/api/uploads?filename=lesson.html', { token: alice.token, method: 'POST', body: html, headers: { 'Content-Type': 'text/html' } });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
  const attachmentId = result.value.attachment.id;

  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Original text', attachmentIds: [attachmentId] } });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
  const messageId = result.value.message.id;
  result = await api(`/api/attachments/${attachmentId}`, { token: bob.token });
  assert.deepEqual(result.value, html);
  assert.match(result.response.headers.get('content-disposition'), /^attachment;/);

  result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'PATCH', body: { content: 'Edited text' } });
  assert.equal(result.value.message.content, 'Edited text');
  result = await api(`/api/messages/${messageId}/reactions/${encodeURIComponent('👍')}`, { token: bob.token, method: 'PUT', body: {} });
  assert.equal(result.response.status, 204);
  result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'DELETE', body: {} });
  assert.equal(result.response.status, 204);
  result = await api(`/api/channels/${channelId}/messages`, { token: bob.token });
  assert.equal(result.value.messages[0].deleted, true);
  assert.equal(result.value.messages[0].content, null);

  result = await api(`/api/servers/${serverId}/logs`, { token: alice.token });
  const deletion = result.value.logs.find((log) => log.event_type === 'message.deleted');
  assert.equal(deletion.payload.originalContent, 'Edited text');
  assert.ok(deletion.expires_at > deletion.created_at);

  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Retain this when the whole server is deleted' } });
  assert.equal(result.response.status, 201);
  result = await api(`/api/servers/${serverId}`, { token: alice.token, method: 'DELETE', body: { confirmName: 'Study Hall', password: 'correct-horse-battery', reason: 'Test server cleanup' } });
  assert.equal(result.response.status, 204);
  const retained = app.db.prepare("SELECT payload FROM audit_logs WHERE server_id=? AND event_type='message.deleted' ORDER BY id DESC LIMIT 1").get(serverId);
  assert.equal(JSON.parse(retained.payload).originalContent, 'Retain this when the whole server is deleted');
  assert.equal(JSON.parse(retained.payload).containerDeleted, true);
}));

test('message deletion and its 30-day retention audit commit atomically', async () => fixture(async ({ app, api, register }) => {
  const alice = await register('alice.atomic-delete');
  let result = await api('/api/servers', { token: alice.token, method: 'POST', body: { name: 'Atomic Delete' } });
  const serverId = result.value.server.id;
  result = await api(`/api/servers/${serverId}`, { token: alice.token });
  const channelId = result.value.channels.find((channel) => channel.type === 'text').id;
  result = await api('/api/uploads?filename=evidence.txt', { token: alice.token, method: 'POST', body: Buffer.from('evidence') });
  const attachmentId = result.value.attachment.id;
  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Retain atomically', attachmentIds: [attachmentId] } });
  const messageId = result.value.message.id;

  app.db.exec(`CREATE TRIGGER fail_message_delete_audit BEFORE INSERT ON audit_logs
    WHEN NEW.event_type='message.deleted' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END`);
  result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'DELETE', body: {} });
  assert.equal(result.response.status, 500);
  let stored = app.db.prepare('SELECT content,deleted_at FROM messages WHERE id=?').get(messageId);
  assert.equal(stored.content, 'Retain atomically');
  assert.equal(stored.deleted_at, null);
  assert.equal(app.db.prepare('SELECT deleted_at FROM attachments WHERE id=?').get(attachmentId).deleted_at, null);
  app.db.exec('DROP TRIGGER fail_message_delete_audit');

  result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'DELETE', body: {} });
  assert.equal(result.response.status, 204);
  stored = app.db.prepare('SELECT content,deleted_at FROM messages WHERE id=?').get(messageId);
  assert.equal(stored.content, null);
  assert.ok(stored.deleted_at);
  const log = app.db.prepare("SELECT payload FROM audit_logs WHERE message_id=? AND event_type='message.deleted'").get(messageId);
  assert.equal(JSON.parse(log.payload).originalContent, 'Retain atomically');
}));

test('declining a DM blocks both participants and hides the conversation from both lists', async () => fixture(async ({ api, register }) => {
  const alice = await register('alice.decline');
  const bob = await register('bob.decline');
  let result = await api('/api/dms', { token: alice.token, method: 'POST', body: { userId: bob.user.id } });
  const dmId = result.value.conversation.id;
  result = await api(`/api/dms/${dmId}/decline`, { token: bob.token, method: 'POST', body: {} });
  assert.equal(result.response.status, 204);

  for (const token of [alice.token, bob.token]) {
    result = await api(`/api/dms/${dmId}/messages`, { token, method: 'POST', body: { content: 'Must stay blocked' } });
    assert.equal(result.response.status, 403);
    assert.equal(result.value.error.code, 'DM_DECLINED');
    result = await api('/api/dms', { token });
    assert.equal(result.value.conversations.some((conversation) => conversation.id === dmId), false);
  }
  result = await api('/api/dms', { token: alice.token, method: 'POST', body: { userId: bob.user.id } });
  assert.equal(result.response.status, 403);
  assert.equal(result.value.error.code, 'DM_DECLINED');
}));

test('DM inspection is explicit, session-bound, audited, and uses the Administration handle', async () => fixture(async ({ app, base, api, register }) => {
  const alice = await register('alice.dm');
  const bob = await register('bob.dm');
  let result = await api('/api/dms', { token: alice.token, method: 'POST', body: { userId: bob.user.id } });
  const dmId = result.value.conversation.id;
  result = await api('/api/uploads?filename=private.txt', { token: alice.token, method: 'POST', body: Buffer.from('private attachment') });
  const attachmentId = result.value.attachment.id;

  const ownerLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'TestOwner', password: 'owner-password-123' } });
  const ownerOtherLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'TestOwner', password: 'owner-password-123' } });
  const ownerToken = ownerLogin.value.token;
  const ownerOtherToken = ownerOtherLogin.value.token;
  result = await api(`/api/attachments/${attachmentId}`, { token: ownerToken });
  assert.equal(result.response.status, 403);

  result = await api(`/api/dms/${dmId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Private note', attachmentIds: [attachmentId] } });
  assert.equal(result.response.status, 201);
  result = await api(`/api/dms/${dmId}/messages`, { token: ownerToken });
  assert.equal(result.response.status, 403);
  result = await api(`/api/admin/dms/${dmId}/open`, { token: ownerToken, method: 'POST', body: { reason: 'Investigating a reported safety concern' } });
  assert.equal(result.response.status, 200);
  const accessRow = app.db.prepare('SELECT * FROM admin_dm_access WHERE id=?').get(result.value.accessId);
  assert.ok(accessRow.session_id);
  result = await api(`/api/dms/${dmId}/messages`, { token: ownerToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.administrativeAccess, true);
  result = await api(`/api/dms/${dmId}/messages`, { token: ownerOtherToken });
  assert.equal(result.response.status, 403);
  assert.equal(result.value.error.code, 'DM_ACCESS_REQUIRED');
  result = await api(`/api/admin/dms/${dmId}/close`, { token: ownerOtherToken, method: 'POST', body: {} });
  assert.equal(result.response.status, 204);
  result = await api(`/api/dms/${dmId}/messages`, { token: ownerToken });
  assert.equal(result.response.status, 200);

  result = await api(`/api/attachments/${attachmentId}`, { token: ownerOtherToken });
  assert.equal(result.response.status, 403);
  result = await api(`/api/attachments/${attachmentId}`, { token: ownerToken });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.value, Buffer.from('private attachment'));

  const inspectedSocket = await openRealtime(base, api, ownerToken);
  const otherSocket = await openRealtime(base, api, ownerOtherToken);
  try {
    inspectedSocket.websocket.send(JSON.stringify({ type: 'subscribe.dm', dmId }));
    otherSocket.websocket.send(JSON.stringify({ type: 'subscribe.dm', dmId }));
    await waitFor(() => inspectedSocket.events.some((event) => event.type === 'subscribed.dm' && event.dmId === dmId), 'Inspected session could not subscribe to its DM.');
    await waitFor(() => otherSocket.events.some((event) => event.type === 'error' && event.code === 'DM_ACCESS_REQUIRED'), 'Uninspected session was not rejected.');
    result = await api(`/api/dms/${dmId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Realtime private note' } });
    assert.equal(result.response.status, 201);
    await waitFor(() => inspectedSocket.events.some((event) => event.type === 'message.created' && event.message?.content === 'Realtime private note'), 'Inspected session missed DM event.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(otherSocket.events.some((event) => event.type === 'message.created' && event.message?.dmId === dmId), false);
  } finally {
    await closeRealtime(inspectedSocket, otherSocket);
  }

  result = await api(`/api/dms/${dmId}/messages`, { token: ownerToken, method: 'POST', body: { content: 'Please keep this conversation respectful.', administration: true } });
  assert.equal(result.response.status, 201, JSON.stringify(result.value));
  assert.equal(result.value.message.author.displayName, 'Administration');
  assert.equal(result.value.message.author.id, null);

  result = await api(`/api/dms/${dmId}/messages`, { token: bob.token });
  const adminMessage = result.value.messages.find((message) => message.administration);
  assert.equal(adminMessage.author.username, 'Administration');
  assert.equal(Object.hasOwn(adminMessage.author, 'actualAdminId'), false);

  result = await api(`/api/admin/logs?dmId=${dmId}&event=dm.administration_message_sent`, { token: ownerToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.logs[0].actor_id, ownerLogin.value.user.id);
  result = await api(`/api/admin/logs?dmId=${dmId}&event=admin.dm_attachment_downloaded`, { token: ownerToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.logs.length, 1);
}));

test('maintenance creates daily administrator expiration warnings and purges expired logs', async () => fixture(async ({ app, api }) => {
  const ownerLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'TestOwner', password: 'owner-password-123' } });
  const ownerId = ownerLogin.value.user.id;
  app.db.prepare("INSERT INTO audit_logs(event_type,actor_id,payload,created_at,expires_at) VALUES ('test.expiring',?,'{}',?,?)").run(ownerId, Date.now(), Date.now() + 86_400_000);
  app.runMaintenance(true);
  let result = await api('/api/admin/notifications', { token: ownerLogin.value.token });
  assert.equal(result.value.notifications[0].type, 'log_expiration');
  app.db.prepare("UPDATE audit_logs SET expires_at=? WHERE event_type='test.expiring'").run(Date.now() - 1);
  app.runMaintenance(true);
  assert.equal(app.db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE event_type='test.expiring'").get().count, 0);
}));

test('one-use realtime tickets deliver authenticated message events from Origin null', async () => fixture(async ({ base, api, register }) => {
  const alice = await register('alice.live');
  let result = await api('/api/servers', { token: alice.token, method: 'POST', body: { name: 'Realtime Room' } });
  const serverId = result.value.server.id;
  result = await api(`/api/servers/${serverId}`, { token: alice.token });
  const channelId = result.value.channels.find((channel) => channel.type === 'text').id;
  result = await api('/api/realtime-ticket', { token: alice.token, method: 'POST', body: {} });
  const ticket = result.value.ticket;
  const websocket = new WebSocket(`${base.replace('http:', 'ws:')}/realtime?ticket=${encodeURIComponent(ticket)}`, { origin: 'null' });
  const events = [];
  websocket.on('message', (data) => events.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
  websocket.send(JSON.stringify({ type: 'typing.start', channelId }));
  result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Live message' } });
  assert.equal(result.response.status, 201);
  const deadline = Date.now() + 1000;
  while ((!events.some((event) => event.type === 'message.created') || !events.some((event) => event.type === 'typing')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.some((event) => event.type === 'hello'));
  const typing = events.find((event) => event.type === 'typing');
  assert.equal(typing.user.username, 'alice.live');
  assert.equal(typing.active, true);
  assert.equal(events.find((event) => event.type === 'message.created').message.content, 'Live message');
  websocket.close();
  await new Promise((resolve) => websocket.once('close', resolve));
}));

test('private channel realtime events are visible only to authorized sockets and global admins', async () => fixture(async ({ base, api, register }) => {
  const alice = await register('alice.private-live');
  const hiddenMember = await register('hidden.private-live');
  const ownerLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'TestOwner', password: 'owner-password-123' } });
  assert.equal(ownerLogin.response.status, 200);

  let result = await api('/api/servers', { token: alice.token, method: 'POST', body: { name: 'Private Realtime Room' } });
  const serverId = result.value.server.id;
  result = await api(`/api/servers/${serverId}`, { token: alice.token, method: 'PATCH', body: { discoverable: true, discoveryMode: 'public' } });
  assert.equal(result.response.status, 200);
  result = await api(`/api/servers/${serverId}/join`, { token: hiddenMember.token, method: 'POST', body: {} });
  assert.equal(result.response.status, 200);

  result = await api(`/api/servers/${serverId}/roles`, { token: alice.token });
  const everyone = result.value.roles.find((role) => role.default);
  result = await api(`/api/roles/${everyone.id}`, { token: alice.token, method: 'PATCH', body: { permissions: 0 } });
  assert.equal(result.response.status, 200);

  const authorized = await openRealtime(base, api, alice.token);
  const hidden = await openRealtime(base, api, hiddenMember.token);
  const globalAdmin = await openRealtime(base, api, ownerLogin.value.token);
  try {
    result = await api(`/api/servers/${serverId}/channels`, { token: alice.token, method: 'POST', body: { name: 'private-planning', type: 'text' } });
    assert.equal(result.response.status, 201, JSON.stringify(result.value));
    const channelId = result.value.channel.id;

    result = await api(`/api/channels/${channelId}`, { token: alice.token, method: 'PATCH', body: { topic: 'Private project details' } });
    assert.equal(result.response.status, 200);
    result = await api(`/api/channels/${channelId}/messages`, { token: alice.token, method: 'POST', body: { content: 'Private message' } });
    assert.equal(result.response.status, 201, JSON.stringify(result.value));
    const messageId = result.value.message.id;
    result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'PATCH', body: { content: 'Private message edited' } });
    assert.equal(result.response.status, 200);
    result = await api(`/api/messages/${messageId}/reactions/${encodeURIComponent('🔒')}`, { token: alice.token, method: 'PUT', body: {} });
    assert.equal(result.response.status, 204);
    authorized.websocket.send(JSON.stringify({ type: 'typing.start', channelId }));
    result = await api(`/api/messages/${messageId}`, { token: alice.token, method: 'DELETE', body: {} });
    assert.equal(result.response.status, 204);
    result = await api(`/api/channels/${channelId}`, { token: alice.token, method: 'DELETE' });
    assert.equal(result.response.status, 204);

    const sawFullSequence = (events) =>
      events.some((event) => event.type === 'channel.created' && event.channel?.id === channelId) &&
      events.some((event) => event.type === 'channel.updated' && event.channel?.id === channelId) &&
      events.some((event) => event.type === 'message.created' && event.message?.channelId === channelId) &&
      events.some((event) => event.type === 'message.updated' && event.message?.content === 'Private message edited') &&
      events.some((event) => event.type === 'message.updated' && event.message?.reactions?.some((reaction) => reaction.emoji === '🔒')) &&
      events.some((event) => event.type === 'typing' && event.channelId === channelId) &&
      events.some((event) => event.type === 'message.deleted' && event.message?.channelId === channelId) &&
      events.some((event) => event.type === 'channel.deleted' && event.channelId === channelId);

    await waitFor(() => sawFullSequence(authorized.events), 'Authorized member missed private-channel realtime events.');
    await waitFor(() => sawFullSequence(globalAdmin.events), 'Global administrator missed private-channel realtime events.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const concernsChannel = (event) => event.channelId === channelId || event.channel?.id === channelId || event.message?.channelId === channelId;
    assert.deepEqual(hidden.events.filter(concernsChannel), []);
  } finally {
    await closeRealtime(authorized, hidden, globalAdmin);
  }
}));
