import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , databasePath] = process.argv;
if (!databasePath) {
  console.error('Usage: node sqlite-check.mjs <database.sqlite>');
  process.exit(64);
}
if (!existsSync(databasePath)) {
  console.error('SQLite database does not exist.');
  process.exit(66);
}

let database;
try {
  database = new DatabaseSync(databasePath, { readOnly: true });
  const result = database.prepare('PRAGMA quick_check').all();
  if (result.length !== 1 || result[0].quick_check !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    database?.close();
  } catch {}
}

