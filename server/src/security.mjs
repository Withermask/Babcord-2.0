import { promisify } from 'node:util';
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const RESERVED = new Set(['admin', 'administrator', 'administration', 'babcock', 'system', 'moderator', 'staff', 'everyone', 'here']);

export function normalizeUsername(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = String(value ?? '').normalize('NFKC').trim();
  const normalized = normalizeUsername(username);
  if (!USERNAME_RE.test(username)) return 'Username must be 3-32 characters using letters, numbers, dot, underscore, or hyphen.';
  if (RESERVED.has(normalized)) return 'That username is reserved.';
  return null;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10) return 'Password must be at least 10 characters.';
  if (value.length > 256) return 'Password is too long.';
  return null;
}

export async function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  const key = await scrypt(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  return { salt, hash: Buffer.from(key).toString('base64url') };
}

export async function verifyPassword(password, salt, expected) {
  try {
    const actual = await scrypt(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function recoveryHash(value, secret) {
  return createHmac('sha256', secret).update(String(value).replaceAll('-', '').toUpperCase()).digest('hex');
}

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(10).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
  });
}

export function safeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function hashIp(ip, secret) {
  return createHmac('sha256', secret).update(ip || 'unknown').digest('hex');
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_path ? `/api/users/${row.id}/avatar` : null,
    globalRole: row.global_role,
    status: row.status,
    createdAt: row.created_at,
  };
}
