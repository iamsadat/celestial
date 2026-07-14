"use strict";
const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { pathToFileURL } = require("url");
const sidecar = require("./sidecar");
const storage = require("./storage");
const { loadExtensions } = require("./extensions");

// Same packaged-vs-dev root split as sidecar.js's REPO_ROOT: core/api_server.py
// writes this token relative to its own file location, which extraResources
// places at process.resourcesPath/core in a packaged build.
const CONTROL_TOKEN_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "desktop", "config", ".api_token")
  : path.join(__dirname, "..", "desktop", "config", ".api_token");

// Same file preload.js exposes as celestial.startPageUrl -- computed
// identically (both files live directly under app/) so the will-attach-webview
// guard below can recognize it by exact string match.
const START_PAGE_URL = pathToFileURL(path.join(__dirname, "renderer", "start.html")).toString();

const CONFIG_API_URL = "http://127.0.0.1:8765/config";

// Shared by setProxyTopLevel (proxy control channel, :8080) and the /config
// proxy calls below (API, :8765) -- both sides read the same token file; see
// core/custom_proxy.py's _load_control_token and core/api_server.py's
// _load_or_create_token.
function readControlToken() {
  try {
    return fs.readFileSync(CONTROL_TOKEN_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

// Tells the proxy sidecar which host the user is navigating to, so its
// whitelist gate (core/custom_proxy.py's is_request_allowed) allows it.
// See custom_proxy.py's _handle_control for why this exists and is token-gated.
function setProxyTopLevel(host) {
  return new Promise((resolve) => {
    const token = readControlToken();
    if (!token) return resolve(false);
    const url = `http://127.0.0.1:8080/__celestial/set-top-level?host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}`;
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Hardening flags ported from core/browser_launcher.py's CHROMIUM_PRIVACY_FLAGS.
// Skipped on purpose: --no-sandbox (Electron sandboxes per-webContents via
// webPreferences.sandbox instead), --disable-gpu/--disk-cache-size (perf, Phase C),
// --disable-extensions (would preclude loading extensions later).
const PRIVACY_SWITCHES = [
  ["disable-background-networking"],
  ["disable-breakpad"],
  ["disable-crash-reporter"],
  ["no-pings"],
  ["disable-quic"],
  ["dns-prefetch-disable"],
  ["host-resolver-rules", "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"],
  ["force-webrtc-ip-handling-policy", "disable_non_proxied_udp"],
  ["webrtc-ip-handling-policy", "disable_non_proxied_udp"],
  ["no-first-run"],
  ["no-default-browser-check"],
  ["disable-sync"],
  ["disable-translate"],
  ["disable-default-apps"],
  ["disable-component-update"],
  ["enable-strict-site-isolation"],
  ["site-per-process"],
];
for (const [flag, value] of PRIVACY_SWITCHES) {
  if (value) app.commandLine.appendSwitch(flag, value);
  else app.commandLine.appendSwitch(flag);
}

const REAL_PROXY_RULES = "http=127.0.0.1:8080;https=127.0.0.1:8080";
// ponytail: port 1 is never listened on -> instant ECONNREFUSED. Simplest fail-closed target.
const BLACKHOLE_PROXY_RULES = "http=127.0.0.1:1;https=127.0.0.1:1";
const PROXY_BYPASS_RULES = "<-loopback>";
const KILLSWITCH_POLL_MS = 2000;

let mainWindow = null;
let killSwitchActive = false;

function checkTunnelHealthy() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:8765/status", { timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data).tunnel_healthy === true); }
        catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Fail-closed native kill-switch: polls the sidecar's own health view (already
// the source of truth for the UI's OFFLINE pill) and, independent of the
// renderer, black-holes the proxy the instant the tunnel drops. Recovers
// automatically when health returns.
async function killSwitchTick() {
  const shouldBlock = !(await checkTunnelHealthy());
  if (shouldBlock === killSwitchActive) return;
  killSwitchActive = shouldBlock;
  await session.defaultSession.setProxy({
    proxyRules: killSwitchActive ? BLACKHOLE_PROXY_RULES : REAL_PROXY_RULES,
    proxyBypassRules: PROXY_BYPASS_RULES,
  });
  console.log(killSwitchActive
    ? "[main] KILL-SWITCH ENGAGED: tunnel unhealthy, tab traffic blocked"
    : "[main] kill-switch cleared: tunnel healthy, traffic restored");
}

function installKillSwitchWatcher() {
  // Second, in-process gate: proxy black-holing needs a network round trip to
  // the refused port to actually fail a request. This cancels immediately for
  // anything already in flight or racing the proxy swap, without waiting on it.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!killSwitchActive) return callback({ cancel: false });
    try {
      const { hostname } = new URL(details.url);
      if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
        return callback({ cancel: true });
      }
    } catch {}
    callback({ cancel: false });
  });
  setInterval(killSwitchTick, KILLSWITCH_POLL_MS);
  killSwitchTick();
  console.log("[main] kill-switch watcher installed");
}

function installPrivacyHandlers() {
  // Deny-by-default: no site gets geolocation/camera/mic/notifications/etc
  // unless a future settings UI explicitly allowlists it.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  console.log("[main] permission deny-by-default handlers installed");
}

// ponytail: filename collisions only -- no resumable/paused-download UI, no
// download manager persistence beyond the completed-list; add if that's ever needed.
function uniquifyPath(dir, filename) {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

let downloadCounter = 0;

function installDownloadHandler() {
  session.defaultSession.on("will-download", (_event, item) => {
    const id = `dl-${++downloadCounter}`;
    const savePath = uniquifyPath(app.getPath("downloads"), item.getFilename());
    item.setSavePath(savePath);

    const send = (payload) => mainWindow?.webContents.send("celestial:downloads:event", { id, ...payload });
    send({ state: "started", filename: path.basename(savePath), path: savePath, totalBytes: item.getTotalBytes() });

    item.on("updated", (_e, state) => {
      if (state === "progressing") {
        send({ state: "progressing", receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      }
    });
    item.once("done", (_e, state) => {
      send({ state, filename: path.basename(savePath), path: savePath });
      if (state === "completed") {
        storage.addDownload({ filename: path.basename(savePath), path: savePath, url: item.getURL(), size: item.getReceivedBytes() });
      }
    });
  });
  console.log("[main] download handler installed");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0f1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");

  // Security guard for <webview>: discard any preload a compromised page tries
  // to smuggle in and pin our own fingerprint shim instead; only allow http(s)
  // targets, plus the exact local new-tab page (its own minimal, read-only
  // preload -- never the fingerprint shim, and never arbitrary file:// paths).
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    webPreferences.preload = params.src === START_PAGE_URL
      ? path.join(__dirname, "start-preload.js")
      : path.join(__dirname, "fingerprint-preload.js");
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//.test(params.src) && params.src !== "about:blank" && params.src !== START_PAGE_URL) {
      event.preventDefault();
    }
  });

  // Covers webviews created after window creation too (every tab, since tabs
  // are opened dynamically by renderer.js) -- did-attach-webview fires per tab.
  mainWindow.webContents.on("did-attach-webview", (_event, webContents) => {
    webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  });
  console.log("[main] WebRTC disable_non_proxied_udp policy wired for webviews");

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("celestial:set-top-level", (_event, host) => setProxyTopLevel(host));

ipcMain.handle("celestial:status", async () => {
  try {
    const res = await fetch("http://127.0.0.1:8765/status");
    return await res.json();
  } catch {
    return { tunnel_healthy: false, status_message: "Sidecar unreachable" };
  }
});

// Storage IPC: renderer never touches fs/crypto directly, only these calls
// through preload's contextBridge. Basic shape validation at the boundary.
ipcMain.handle("celestial:bookmarks:list", () => storage.listBookmarks());
ipcMain.handle("celestial:bookmarks:add", (_event, b) => {
  if (!b || typeof b.url !== "string" || !b.url) throw new Error("invalid bookmark payload");
  return storage.addBookmark({ url: b.url, title: typeof b.title === "string" ? b.title : undefined });
});
ipcMain.handle("celestial:bookmarks:delete", (_event, id) => {
  if (typeof id !== "string") throw new Error("invalid bookmark id");
  return storage.deleteBookmark(id);
});
ipcMain.handle("celestial:tabs:get", () => storage.getOpenTabs());
ipcMain.handle("celestial:tabs:save", (_event, tabs) => {
  if (!Array.isArray(tabs)) throw new Error("invalid tabs payload");
  return storage.saveOpenTabs(tabs);
});

ipcMain.handle("celestial:history:list", () => storage.listHistory());
ipcMain.handle("celestial:history:add", (_event, h) => {
  if (!h || typeof h.url !== "string" || !h.url) throw new Error("invalid history payload");
  return storage.recordHistory({ url: h.url, title: typeof h.title === "string" ? h.title : undefined });
});
ipcMain.handle("celestial:history:clear", () => storage.clearHistory());
ipcMain.handle("celestial:history:delete", (_event, id) => {
  if (typeof id !== "string") throw new Error("invalid history id");
  return storage.deleteHistoryEntry(id);
});

ipcMain.handle("celestial:downloads:list", () => storage.listDownloads());
ipcMain.handle("celestial:downloads:show", (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) throw new Error("invalid path");
  shell.showItemInFolder(filePath);
});

// Proxies GET/POST /config to the Python control API (:8765) so the renderer
// never sees the X-Celestial-Token -- only main reads it off disk (see
// readControlToken). Config shape (whitelist, network_obfuscation.*) is
// entirely owned by core/api_server.py + core/tunnel_manager.py; this is a
// thin pass-through, not a schema owner.
ipcMain.handle("celestial:config:get", async () => {
  const token = readControlToken();
  if (!token) return { error: "control token unavailable" };
  try {
    const res = await fetch(CONFIG_API_URL, { headers: { "X-Celestial-Token": token } });
    return await res.json();
  } catch {
    return { error: "config unreachable" };
  }
});
ipcMain.handle("celestial:config:set", async (_event, config) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config payload");
  const token = readControlToken();
  if (!token) return { error: "control token unavailable" };
  try {
    const res = await fetch(CONFIG_API_URL, {
      method: "POST",
      headers: { "X-Celestial-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return await res.json();
  } catch {
    return { error: "config unreachable" };
  }
});

app.whenReady().then(async () => {
  storage.init();

  try {
    await sidecar.start();
  } catch (err) {
    console.error("[main] sidecar failed to start:", err.message);
    app.quit();
    return;
  }

  // Route the default session (and every <webview>, which inherits it since
  // none of them set a partition) through the Celestial privacy proxy.
  await session.defaultSession.setProxy({
    proxyRules: REAL_PROXY_RULES,
    proxyBypassRules: PROXY_BYPASS_RULES,
  });
  console.log("[main] proxy applied:", await session.defaultSession.resolveProxy("https://example.com"));

  await loadExtensions(session.defaultSession);

  installPrivacyHandlers();
  installKillSwitchWatcher();
  installDownloadHandler();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  sidecar.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => sidecar.stop());
