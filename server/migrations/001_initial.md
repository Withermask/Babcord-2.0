# Migration 1

`../schema.sql` is the canonical idempotent initial schema. `src/database.mjs` applies it and records migration version 1 before applying incremental SQL files such as `002_attachment-purpose.sql`.
