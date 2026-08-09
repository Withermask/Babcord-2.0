import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const clientRoot = new URL("../client/", import.meta.url);
const projectRoot = new URL("../", import.meta.url);
const execFileAsync = promisify(execFile);

async function clientFile(name) {
  return readFile(new URL(name, clientRoot), "utf8");
}

test("portable client is self-contained and file-origin aware", async () => {
  const [html, config, app, css] = await Promise.all([
    clientFile("index.html"),
    clientFile("config.js"),
    clientFile("app.js"),
    clientFile("app.css"),
  ]);

  assert.match(html, /Content-Security-Policy/i);
  assert.match(html, /connect-src[^;]*babcord\.withermask\.net/i);
  assert.match(html, /<script src="config\.js"><\/script>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:js|css)/i);
  assert.match(config, /apiBaseUrl:\s*`\$\{apiOrigin\}\/api`/);
  assert.match(config, /"zip",\s*"html",\s*"htm"/);
  assert.match(app, /class BabcordAPI/);
  assert.match(app, /Feature Under Construction!/);
  assert.match(app, /Administration/);
  assert.match(css, /--brand:\s*#7c6ff2/i);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\[data-theme="light"\]/);
});

test("file launcher downloads, verifies, caches, and locally runs the GitHub client", async () => {
  const launcher = await clientFile("Open Babcord.html");
  assert.match(launcher, /const UPDATE_DESCRIPTOR_URL = "https:\/\/raw\.githubusercontent\.com\//);
  assert.match(launcher, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(launcher, /indexedDB\.open\(DATABASE_NAME/);
  assert.match(launcher, /LOCAL_STORAGE_KEY/);
  assert.match(launcher, /elements\.client\.srcdoc = record\.html/);
  assert.match(launcher, /last verified Babcord client saved on this device/i);
  assert.match(launcher, /descriptor\.sha256/);
  assert.match(launcher, /anyCached\?\.sha256 === descriptor\.sha256/);
  assert.match(launcher, /\/clients\/\$\{normalizedHash\}\.html/);
  assert.match(launcher, /Retry now/);
  assert.match(launcher, /Content-Security-Policy/i);
  assert.doesNotMatch(launcher, /\/health|\/client\/index\.html/);
  assert.doesNotMatch(launcher, /babcord\.withermask\.net/);
});

test("portable builder deterministically creates an address-embedded, content-addressed release", async () => {
  const first = await mkdtemp(new URL(".portable-test-a-", projectRoot));
  const second = await mkdtemp(new URL(".portable-test-b-", projectRoot));
  const runBuild = async (directory) => {
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL("scripts/build-portable-client.mjs", projectRoot)),
      "--api-origin", "https://babcord-203-0-113-10.sslip.io",
      "--home-ip", "203.0.113.10",
      "--version", "1.2.3",
      "--github-owner", "school-owner",
      "--github-repo", "babcord-client",
      "--github-branch", "main",
      "--output-dir", directory,
      "--launcher-output", `${directory}\\Open Local Babcord.html`
    ], { cwd: new URL(".", projectRoot) });
  };

  try {
    await runBuild(first);
    await runBuild(second);
    const [firstDescriptorText, secondDescriptorText] = await Promise.all([
      readFile(`${first}\\latest.json`, "utf8"),
      readFile(`${second}\\latest.json`, "utf8")
    ]);
    assert.equal(firstDescriptorText, secondDescriptorText);
    assert.equal(
      await readFile(`${first}\\Open Local Babcord.html`, "utf8"),
      await readFile(`${second}\\Open Local Babcord.html`, "utf8")
    );
    const descriptor = JSON.parse(firstDescriptorText);
    assert.deepEqual(Object.keys(descriptor), ["schemaVersion", "version", "clientUrl", "sha256", "sizeBytes", "format"]);
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.version, "1.2.3");
    assert.equal(descriptor.format, "babcord-single-html-v1");
    assert.match(descriptor.clientUrl, new RegExp(`/releases/clients/${descriptor.sha256}\\.html$`));
    assert.doesNotMatch(firstDescriptorText, /203\.0\.113\.10|sslip\.io|apiOrigin|homeIp/i);

    const firstClient = await readFile(`${first}\\clients\\${descriptor.sha256}.html`);
    const secondClient = await readFile(`${second}\\clients\\${descriptor.sha256}.html`);
    assert.deepEqual(firstClient, secondClient);
    assert.equal(firstClient.byteLength, descriptor.sizeBytes);
    assert.equal(createHash("sha256").update(firstClient).digest("hex"), descriptor.sha256);
    const html = firstClient.toString("utf8");
    assert.match(html, /name="babcord-client-version" content="1\.2\.3"/);
    assert.match(html, /name="babcord-home-ip" content="203\.0\.113\.10"/);
    assert.match(html, /name="babcord-api-origin" content="https:\/\/babcord-203-0-113-10\.sslip\.io"/);
    assert.match(html, /connect-src https:\/\/babcord-203-0-113-10\.sslip\.io wss:\/\/babcord-203-0-113-10\.sslip\.io/);
    assert.match(html, /serverManifestEnabled:\s*false/);
    assert.doesNotMatch(html, /(?:src|href)=["'](?:app\.js|config\.js|app\.css)["']/i);
    assert.equal((await readdir(`${first}\\clients`)).length, 1);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("critical product surfaces are present", async () => {
  const [html, app] = await Promise.all([clientFile("index.html"), clientFile("app.js")]);
  const combined = `${html}\n${app}`;
  for (const phrase of [
    "Create an account",
    "Save your recovery codes",
    "Direct messages",
    "Discovery",
    "Audit log",
    "Administration",
    "Delete account",
    "Feature Under Construction!",
  ]) {
    assert.match(combined, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("client uses the canonical protected API contract", async () => {
  const app = await clientFile("app.js");

  for (const obsoleteRoute of [
    /\/admin\/servers\/\$\{[^}]+\}\/logs/,
    /api\.delete\(`\/admin\/servers\//,
    /\/admin\/dms\/\$\{[^}]+\}\/messages/,
    /\/me\/settings/,
    /api\.(?:get|post)\(`\/search/,
  ]) {
    assert.doesNotMatch(app, obsoleteRoute);
  }

  assert.match(app, /\/admin\/dms\/\$\{[^}]+\}\/open/);
  assert.match(app, /\/dms\/\$\{[^}]+\}\/messages/);
  assert.match(app, /\/servers\/\$\{[^}]+\}\/logs/);
  assert.match(app, /uploaded\.attachment \|\| uploaded/);
  assert.match(app, /data-secure-src/);
  assert.match(app, /protectedBlob/);
});

test("short viewports keep navigation and account controls on screen", async () => {
  const css = await clientFile("app.css");
  assert.match(css, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.app\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.nav-sidebar\s*\{[^}]*min-height:\s*0/s);
});
