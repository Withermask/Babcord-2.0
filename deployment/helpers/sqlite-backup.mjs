import { existsSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

const [, , sourcePath, destinationPath] = process.argv;
if (!sourcePath || !destinationPath) {
  console.error('Usage: node sqlite-backup.mjs <source.sqlite> <destination.sqlite>');
  process.exit(64);
}
if (!existsSync(sourcePath)) {
  console.error('Source SQLite database does not exist.');
  process.exit(66);
}
if (existsSync(destinationPath)) {
  console.error('Destination already exists; refusing to overwrite it.');
  process.exit(73);
}

let source;
let destination;
try {
  source = new DatabaseSync(sourcePath, { readOnly: true });
  const sourceCheck = source.prepare('PRAGMA quick_check').all();
  if (sourceCheck.length !== 1 || sourceCheck[0].quick_check !== 'ok') {
    throw new Error('Source database failed PRAGMA quick_check.');
  }

  const pages = await backup(source, destinationPath, { rate: 256 });
  source.close();
  source = undefined;

  destination = new DatabaseSync(destinationPath, { readOnly: true });
  const destinationCheck = destination.prepare('PRAGMA quick_check').all();
  if (destinationCheck.length !== 1 || destinationCheck[0].quick_check !== 'ok') {
    throw new Error('Backup database failed PRAGMA quick_check.');
  }
  destination.close();
  destination = undefined;

  process.stdout.write(JSON.stringify({ ok: true, pages }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try {
    destination?.close();
  } catch {}
  try {
    source?.close();
  } catch {}
}

