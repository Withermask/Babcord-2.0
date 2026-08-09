PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  global_role TEXT NOT NULL DEFAULT 'user' CHECK(global_role IN ('user','admin','owner')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
  muted_until INTEGER,
  avatar_path TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  ip_hash TEXT
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_path TEXT,
  owner_id INTEGER REFERENCES users(id),
  is_system INTEGER NOT NULL DEFAULT 0,
  discoverable INTEGER NOT NULL DEFAULT 0,
  discovery_mode TEXT NOT NULL DEFAULT 'public' CHECK(discovery_mode IN ('public','invite','approval')),
  discovery_category TEXT,
  discovery_tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS only_one_system_server ON servers(is_system) WHERE is_system=1;

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  muted_until INTEGER,
  PRIMARY KEY(server_id,user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#99aab5',
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_default_role ON roles(server_id) WHERE is_default=1;

CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY(server_id,user_id,role_id),
  FOREIGN KEY(server_id,user_id) REFERENCES server_members(server_id,user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('text','category','voice')),
  position INTEGER NOT NULL DEFAULT 0,
  user_limit INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('role','member')),
  target_id INTEGER NOT NULL,
  allow_bits INTEGER NOT NULL DEFAULT 0,
  deny_bits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id,target_type,target_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS membership_requests (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER REFERENCES users(id),
  PRIMARY KEY(server_id,user_id)
);

CREATE TABLE IF NOT EXISTS server_bans (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY(server_id,user_id)
);

CREATE TABLE IF NOT EXISTS dm_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_participants (
  dm_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_state TEXT NOT NULL DEFAULT 'accepted' CHECK(request_state IN ('pending','accepted','declined')),
  joined_at INTEGER NOT NULL,
  last_read_message_id INTEGER,
  PRIMARY KEY(dm_id,user_id)
);

CREATE TABLE IF NOT EXISTS dm_blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(blocker_id,blocked_id)
);

CREATE TABLE IF NOT EXISTS admin_dm_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dm_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE CASCADE,
  content TEXT,
  reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  administration INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER REFERENCES users(id),
  CHECK((channel_id IS NOT NULL AND dm_id IS NULL) OR (channel_id IS NULL AND dm_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS messages_channel_time ON messages(channel_id,created_at DESC);
CREATE INDEX IF NOT EXISTS messages_dm_time ON messages(dm_id,created_at DESC);

CREATE TABLE IF NOT EXISTS message_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  editor_id INTEGER NOT NULL REFERENCES users(id),
  old_content TEXT,
  new_content TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'message' CHECK(purpose IN ('message','avatar','server_icon')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(message_id,user_id,emoji)
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id,user_id)
);

CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,user_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  server_id INTEGER,
  dm_id INTEGER,
  message_id INTEGER,
  target_type TEXT,
  target_id INTEGER,
  reason TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_expiry ON audit_logs(expires_at);
CREATE INDEX IF NOT EXISTS audit_server_time ON audit_logs(server_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_dm_time ON audit_logs(dm_id,created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,dedupe_key)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  message_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS voice_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  dm_id INTEGER REFERENCES dm_conversations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
