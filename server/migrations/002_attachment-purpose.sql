-- Applied by src/database.mjs only when upgrading a v1 database that lacks this column.
ALTER TABLE attachments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'message'
  CHECK(purpose IN ('message','avatar','server_icon'));
