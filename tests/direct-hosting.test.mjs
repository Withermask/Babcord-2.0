import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const root = new URL("../", import.meta.url);
const deployment = new URL("../deployment/", import.meta.url);
const scripts = new URL("scripts/", deployment);

async function text(relative) {
  return readFile(new URL(relative, root), "utf8");
}

test("one-click direct hosting keeps Node private and exposes only Caddy HTTPS", async () => {
  for (const file of [
    "Setup Babcord Direct.bat",
    "Configure Babcord GitHub.bat",
    "Start Babcord Direct.bat",
    "Stop Babcord Direct.bat",
    "Status Babcord Direct.bat",
  ]) {
    await access(new URL(file, root), constants.R_OK);
  }

  const [common, start, firewall] = await Promise.all([
    readFile(new URL("Direct-Common.ps1", scripts), "utf8"),
    readFile(new URL("Start-BabcordDirect.ps1", scripts), "utf8"),
    readFile(new URL("Set-BabcordDirectFirewall.ps1", scripts), "utf8"),
  ]);
  assert.match(common, /reverse_proxy 127\.0\.0\.1:\$BackendPort/);
  assert.match(common, /two independent HTTPS services did not agree/i);
  assert.match(common, /carrier-grade NAT/i);
  assert.match(start, /BABCORD_HOST|Get-BabcordContext/);
  assert.match(start, /public HTTPS route did not become ready/i);
  assert.match(start, /descriptor was preserved/i);
  assert.match(firewall, /LocalPort \$definition\.Port -Program \$caddyPath/);
  assert.match(firewall, /Port = 443/);
  assert.match(firewall, /Port = 80/);
  assert.doesNotMatch(start, /http:\/\/\$publicHost|ws:\/\/\$publicHost/);
});

test("GitHub publisher never stores a token in config and updates descriptor last", async () => {
  const [config, publisher, tokenScript] = await Promise.all([
    text("deployment/direct-config.example.env"),
    readFile(new URL("Publish-BabcordClientToGitHub.ps1", scripts), "utf8"),
    readFile(new URL("Set-BabcordGitHubToken.ps1", scripts), "utf8"),
  ]);
  assert.doesNotMatch(config, /^BABCORD_GITHUB_TOKEN=/m);
  assert.match(config, /^BABCORD_GITHUB_TOKEN_FILE=/m);
  assert.match(tokenScript, /Read-Host 'Token' -AsSecureString/);
  assert.match(tokenScript, /icacls\.exe/);
  const immutable = publisher.indexOf('RemotePath "$releasesPath/clients/$hash.html"');
  const launcher = publisher.indexOf('RemotePath "$releasesPath/Open Babcord.html"');
  const descriptor = publisher.indexOf("RemotePath $manifestPath");
  assert.ok(immutable >= 0 && launcher > immutable && descriptor > launcher,
    "immutable client and launcher must exist before latest.json changes");
});

test("server manifest can point downloads at the GitHub-distributed local launcher", async () => {
  const [config, app] = await Promise.all([
    text("server/src/config.mjs"),
    text("server/src/app.mjs"),
  ]);
  assert.match(config, /BABCORD_CLIENT_DOWNLOAD_URL/);
  assert.match(app, /config\.clientDownloadUrl \|\|/);
});

