-- Existing access records remain available for audit history but deliberately
-- become unusable until a new, session-bound access record is opened.
ALTER TABLE admin_dm_access ADD COLUMN session_id INTEGER
  REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_admin_dm_access_session_active
  ON admin_dm_access(admin_id,session_id,dm_id,closed_at,last_access_at);
