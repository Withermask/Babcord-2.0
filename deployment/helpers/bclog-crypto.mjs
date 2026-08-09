import { createDecipheriv, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('BABCORD1', 'ascii');
const HEADER_BYTES = MAGIC.length + 16 + 12 + 16;

export function decryptBclog(input, password) {
  const archive = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (archive.length <= HEADER_BYTES || !archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not a supported Babcord log archive.');
  }
  if (typeof password !== 'string' || !password.length) {
    throw new Error('A password is required.');
  }

  const saltStart = MAGIC.length;
  const ivStart = saltStart + 16;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  const salt = archive.subarray(saltStart, ivStart);
  const iv = archive.subarray(ivStart, tagStart);
  const tag = archive.subarray(tagStart, ciphertextStart);
  const ciphertext = archive.subarray(ciphertextStart);

  let cleartext;
  try {
    const key = scryptSync(password, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('The password is incorrect or the archive has been damaged.');
  }

  let payload;
  try {
    payload = JSON.parse(cleartext.toString('utf8'));
  } catch {
    throw new Error('The decrypted archive does not contain valid Babcord JSON.');
  }
  if (payload?.format !== 'babcord-audit-v1' || !Array.isArray(payload.records)) {
    throw new Error('The decrypted archive uses an unsupported Babcord log format.');
  }
  return payload;
}

