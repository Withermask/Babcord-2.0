(() => {
  "use strict";

  const query = new URLSearchParams(globalThis.location?.search || "");
  const defaultOrigin = "https://babcord.withermask.net";

  function normalizeOrigin(value) {
    const candidate = String(value || defaultOrigin).trim().replace(/\/+$/, "");
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return defaultOrigin;
    }
  }

  const apiOrigin = normalizeOrigin(query.get("api"));
  const explicitWs = query.get("ws");
  const inferredWs = apiOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

  globalThis.BABCORD_CONFIG = Object.freeze({
    productName: "Babcord",
    clientVersion: "1.0.0",
    apiOrigin,
    apiBaseUrl: `${apiOrigin}/api`,
    healthUrl: `${apiOrigin}/health`,
    manifestUrl: `${apiOrigin}/client/manifest.json`,
    serverManifestEnabled: true,
    realtimeUrl: explicitWs || `${inferredWs}/realtime`,
    requestTimeoutMs: 12000,
    healthTimeoutMs: 3500,
    websocketHeartbeatMs: 25000,
    websocketReconnectMaxMs: 30000,
    maxImageBytes: 5 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxAttachments: 4,
    allowedExtensions: Object.freeze([
      "png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "docx", "pptx",
      "xlsx", "zip", "html", "htm"
    ]),
    previewMode: query.get("preview") === "1",
    storageKeys: Object.freeze({
      session: "babcord.session",
      theme: "babcord.theme",
      density: "babcord.density",
      lastPlace: "babcord.last-place"
    })
  });
})();
