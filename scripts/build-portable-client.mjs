import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const placeholderOwner = "REPLACE_WITH_GITHUB_OWNER";
const placeholderRepository = "REPLACE_WITH_GITHUB_REPOSITORY";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const [rawName, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const name = rawName.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const value = inlineValue ?? argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${rawName}`);
    options[name] = value;
  }
  return options;
}

function normalizeText(value) {
  return String(value).replace(/\r\n?/g, "\n");
}

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) || [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  return source.replace(pattern, replacement);
}

function normalizeOrigin(value) {
  const parsed = new URL(String(value || "").trim());
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error("--api-origin must use HTTPS (HTTP is allowed only for loopback testing). ");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("--api-origin must be an origin only, without credentials, a path, query, or fragment.");
  }
  return parsed.origin;
}

function normalizeGithubUrl(value, optionName) {
  const parsed = new URL(String(value || "").trim());
  const supported = parsed.hostname === "raw.githubusercontent.com" || parsed.hostname === "github.com";
  if (parsed.protocol !== "https:" || !supported || parsed.username || parsed.password) {
    throw new Error(`${optionName} must be an HTTPS raw.githubusercontent.com or github.com URL.`);
  }
  return parsed.toString();
}

function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (character) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character]);
}

function inlineSafeScript(value) {
  return value.replace(/<\/script/gi, "<\\/script");
}

function inlineSafeStyle(value) {
  return value.replace(/<\/style/gi, "<\\/style");
}

function assertVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must look like 1.2.3 or 1.2.3-preview.1.");
  }
  return version;
}

function normalizeHomeIp(value) {
  if (value == null || String(value).trim() === "") return "";
  const candidate = String(value).trim();
  const octets = candidate.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255 || String(Number(octet)) !== octet)) {
    throw new Error("--home-ip must be a plain IPv4 address such as 203.0.113.10.");
  }
  return candidate;
}

const args = parseArguments(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = assertVersion(args.version || process.env.BABCORD_CLIENT_VERSION || packageJson.version);
const apiOrigin = normalizeOrigin(args.apiOrigin || process.env.BABCORD_API_ORIGIN || "https://babcord.withermask.net");
const homeIp = normalizeHomeIp(args.homeIp || process.env.BABCORD_HOME_IP);
const githubOwner = String(args.githubOwner || process.env.BABCORD_GITHUB_OWNER || placeholderOwner).trim();
const githubRepository = String(args.githubRepo || process.env.BABCORD_GITHUB_REPOSITORY || placeholderRepository).trim();
const githubBranch = String(args.githubBranch || process.env.BABCORD_GITHUB_BRANCH || "main").trim();
if (![githubOwner, githubRepository, githubBranch].every((value) => /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes(".."))) {
  throw new Error("GitHub owner, repository, and branch contain unsupported characters.");
}
const rawRoot = `https://raw.githubusercontent.com/${githubOwner}/${githubRepository}/${githubBranch}/releases`;
const descriptorUrl = normalizeGithubUrl(
  args.descriptorUrl || process.env.BABCORD_UPDATE_DESCRIPTOR_URL || `${rawRoot}/latest.json`,
  "--descriptor-url"
);
const clientUrlTemplate = String(args.clientUrl || process.env.BABCORD_CLIENT_DOWNLOAD_URL || `${rawRoot}/clients/__SHA256__.html`).trim();
if (!clientUrlTemplate.includes("__SHA256__")) {
  throw new Error("--client-url must contain __SHA256__ so every published client URL is immutable.");
}
const outputDirectory = resolve(root, args.outputDir || "releases");
const launcherOutput = resolve(root, args.launcherOutput || "client/Open Babcord.html");

if (!outputDirectory.startsWith(root) || !launcherOutput.startsWith(root)) {
  throw new Error("Output paths must remain inside the Babcord project.");
}

const [rawIndex, rawConfig, rawCss, rawApp, rawLauncherTemplate] = await Promise.all([
  readFile(resolve(root, "client/index.html"), "utf8"),
  readFile(resolve(root, "client/config.js"), "utf8"),
  readFile(resolve(root, "client/app.css"), "utf8"),
  readFile(resolve(root, "client/app.js"), "utf8"),
  readFile(resolve(root, "client/Open Babcord.template.html"), "utf8")
]);

let index = normalizeText(rawIndex);
let config = normalizeText(rawConfig);
const css = normalizeText(rawCss).trimEnd();
const app = normalizeText(rawApp).trimEnd();
const websocketOrigin = apiOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
const homeIpMeta = homeIp ? `\n    <meta name="babcord-home-ip" content="${escapeAttribute(homeIp)}">` : "";
const applicationCsp = [
  "default-src 'none'",
  `connect-src ${apiOrigin} ${websocketOrigin}`,
  `img-src data: blob: ${apiOrigin}`,
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

index = replaceExactlyOnce(index, /\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, "", "application CSP meta tag");
index = replaceExactlyOnce(
  index,
  /(<meta charset="utf-8">)/i,
  `$1\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(applicationCsp)}">\n    <meta name="babcord-client-version" content="${escapeAttribute(version)}">\n    <meta name="babcord-api-origin" content="${escapeAttribute(apiOrigin)}">${homeIpMeta}`,
  "charset meta tag"
);
index = replaceExactlyOnce(index, /\s*<link rel="stylesheet" href="app\.css">/i, `\n    <style>\n${inlineSafeStyle(css)}\n    </style>`, "application stylesheet link");

config = replaceExactlyOnce(config, /const defaultOrigin = "[^"]+";/, `const defaultOrigin = ${JSON.stringify(apiOrigin)};`, "default API origin");
config = replaceExactlyOnce(config, /clientVersion:\s*"[^"]+"/, `clientVersion: ${JSON.stringify(version)}`, "client version");
config = replaceExactlyOnce(config, /serverManifestEnabled:\s*true/, "serverManifestEnabled: false", "portable update-mode flag");

index = replaceExactlyOnce(index, /\s*<script src="config\.js"><\/script>/i, `\n    <script>\n${inlineSafeScript(config.trimEnd())}\n    </script>`, "configuration script tag");
index = replaceExactlyOnce(index, /\s*<script src="app\.js"><\/script>/i, `\n    <script>\n${inlineSafeScript(app)}\n    </script>`, "application script tag");

const completeClient = `${index.trimEnd()}\n`;
if (/\b(?:src|href)=["'](?:app\.js|config\.js|app\.css)["']/i.test(completeClient)) {
  throw new Error("The generated client still contains a local application asset reference.");
}
const clientBytes = Buffer.from(completeClient, "utf8");
const sha256 = createHash("sha256").update(clientBytes).digest("hex");
const clientUrl = normalizeGithubUrl(clientUrlTemplate.replaceAll("__SHA256__", sha256), "--client-url");

const descriptorPayload = {
  schemaVersion: 1,
  version,
  clientUrl,
  sha256,
  sizeBytes: clientBytes.byteLength,
  format: "babcord-single-html-v1"
};
const descriptor = `${JSON.stringify(descriptorPayload, null, 2)}\n`;
const launcher = normalizeText(rawLauncherTemplate).replace(
  "__BABCORD_UPDATE_DESCRIPTOR_URL_JSON__",
  JSON.stringify(descriptorUrl).replace(/</g, "\\u003c")
);
if (launcher.includes("__BABCORD_UPDATE_DESCRIPTOR_URL_JSON__")) {
  throw new Error("Launcher descriptor URL placeholder was not replaced.");
}

await mkdir(outputDirectory, { recursive: true });
await mkdir(resolve(outputDirectory, "clients"), { recursive: true });
await mkdir(dirname(launcherOutput), { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "clients", `${sha256}.html`), clientBytes),
  writeFile(resolve(outputDirectory, "latest.json"), descriptor, "utf8"),
  writeFile(resolve(outputDirectory, "Open Babcord.html"), launcher, "utf8"),
  writeFile(launcherOutput, launcher, "utf8")
]);

console.log(`Built Babcord client ${version}`);
console.log(`Embedded server: ${apiOrigin}`);
console.log(`SHA-256: ${sha256}`);
console.log(`Release directory: ${outputDirectory}`);
console.log(`Permanent launcher: ${launcherOutput}`);
