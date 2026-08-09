import { extname, resolve, sep } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const source = pattern.replace(/:[A-Za-z0-9_]+/g, (part) => {
      keys.push(part.slice(1));
      return '([^/]+)';
    });
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}/?$`), keys, handler, options });
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]); });
      return { ...route, params };
    }
    return null;
  }
}

export function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

export function sendEmpty(response, status = 204, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

export async function readBuffer(request, limit) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Maximum upload size is ${limit} bytes.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Maximum upload size is ${limit} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request, limit = 1_000_000) {
  const buffer = await readBuffer(request, limit);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
}

export function requireText(value, name, min = 1, max = 2000) {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_FIELD', `${name} must be text.`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new HttpError(400, 'INVALID_FIELD', `${name} must be ${min}-${max} characters.`);
  return result;
}

export function optionalText(value, name, max = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'INVALID_FIELD', `${name} must be at most ${max} characters.`);
  return value.trim();
}

export function boundedInteger(value, name, min, max, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, 'INVALID_FIELD', `${name} must be between ${min} and ${max}.`);
  return number;
}

export function boolean(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

export function clientIp(request) {
  const forwarded = String(request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

export class RateLimiter {
  constructor() { this.buckets = new Map(); }

  check(bucket, key, limit, windowMs) {
    const now = Date.now();
    const id = `${bucket}:${key}`;
    const values = (this.buckets.get(id) ?? []).filter((time) => time > now - windowMs);
    if (values.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((values[0] + windowMs - now) / 1000));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.', { retryAfter });
    }
    values.push(now);
    this.buckets.set(id, values);
    if (this.buckets.size > 20_000) this.sweep(now);
  }

  sweep(time = Date.now()) {
    for (const [key, values] of this.buckets) {
      const active = values.filter((value) => value > time - 3_600_000);
      if (active.length) this.buckets.set(key, active);
      else this.buckets.delete(key);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveFile(response, root, relative, extraHeaders = {}) {
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, relative);
  if (!(filePath === rootPath || filePath.startsWith(rootPath + sep)) || !existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const info = statSync(filePath);
  response.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': filePath.endsWith('index.html') || filePath.endsWith('config.js') ? 'no-cache' : 'public, max-age=300',
    ...extraHeaders,
  });
  createReadStream(filePath).pipe(response);
  return true;
}

export function contentDisposition(name) {
  const safe = String(name).replace(/[\r\n"\\]/g, '_').slice(0, 200);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
