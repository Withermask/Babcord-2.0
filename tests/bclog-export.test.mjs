import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import test from 'node:test';
import { decryptBclog } from '../deployment/helpers/bclog-crypto.mjs';

function archive(payload, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  return Buffer.concat([Buffer.from('BABCORD1'), salt, iv, cipher.getAuthTag(), encrypted]);
}

test('encrypted Babcord log exports round-trip and reject wrong passwords or tampering', () => {
  const password = 'correct horse battery staple';
  const payload = { format: 'babcord-audit-v1', exportedAt: Date.now(), records: [{ id: 1, action: 'message.deleted' }] };
  const bytes = archive(payload, password);

  assert.deepEqual(decryptBclog(bytes, password), payload);
  assert.throws(() => decryptBclog(bytes, 'wrong password'), /incorrect|damaged/i);

  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBclog(tampered, password), /incorrect|damaged/i);
  assert.throws(() => decryptBclog(Buffer.from('not-an-archive'), password), /not a supported/i);
});

