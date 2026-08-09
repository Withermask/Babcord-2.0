import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin } from 'node:process';
import { decryptBclog } from './bclog-crypto.mjs';

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const [, , inputArgument, outputArgument] = process.argv;
if (!inputArgument || !outputArgument) {
  console.error('Usage: decrypt-bclog.mjs <input.bclog> <output.json>');
  process.exitCode = 2;
} else {
  try {
    const encodedPassword = await readStandardInput();
    const password = Buffer.from(encodedPassword, 'base64').toString('utf8');
    const payload = decryptBclog(readFileSync(resolve(inputArgument)), password);
    const outputPath = resolve(outputArgument);
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outputPath, records: payload.records.length }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The archive could not be opened.');
    process.exitCode = 1;
  }
}

