import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const index = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const launcher = await readFile(new URL('./Open Babcord.html', import.meta.url), 'utf8');

test('application CSP allows generated style attributes without allowing inline scripts', () => {
  const csp = index.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.match(csp, /style-src-elem 'self' blob:/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /script-src 'self' blob:/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test('portable launcher remains self-contained and allows its verified client to connect', () => {
  const csp = launcher.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src https: wss:/);
  assert.match(launcher, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(launcher, /indexedDB\.open/);
  assert.match(launcher, /\.srcdoc = record\.html/);
  assert.doesNotMatch(launcher, /\/health|\/client\/index\.html/);
});
