"use strict";
const { app, BrowserWindow, ipcMain, session, shell, Menu, clipboard, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { pathToFileURL } = require("url");
const sidecar = require("./sidecar");
const storage = require("./storage");
const { loadExtensions } = require("./extensions");
const { fetchUblock } = require("./extensions/fetch-ublock");

// Crash/error logging: append-only JSON-lines file under userData, no
// external service required. ponytail: this is the whole crash-reporting
// story today -- upgrade path is `npm install @sentry/electron` and setting
// CELESTIAL_SENTRY_DSN (see the dynamic require near app.whenReady below),
// no code changes needed beyond that when the time comes.
function logCrash(type, detail) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, detail }) + "\n";
    fs.appendFileSync(path.join(app.getPath("userData"), "crash.log"), line);
  } catch {}
}
process.on("uncaughtException", (err) => logCrash("uncaughtException", { message: err.message, stack: err.stack }));
process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", { reason: String(reason) }));

// Opt-in Sentry: only touched if the operator sets a DSN, and @sentry/electron
// is not a dependency of this project -- `npm install @sentry/electron` is the
// entire upgrade path, no other code changes needed.
if (process.env.CELESTIAL_SENTRY_DSN) {
  try {
    const Sentry = require("@sentry/electron/main");
    Sentry.init({ dsn: process.env.CELESTIAL_SENTRY_DSN });
  } catch (err) {
    console.warn("[main] CELESTIAL_SENTRY_DSN set but @sentry/electron isn't installed:", err.message);
  }
}

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
function setProxyTopLevel(host, action = "add") {
  return new Promise((resolve) => {
    const token = readControlToken();
    if (!token) return resolve(false);
    const url = `http://127.0.0.1:8080/__celestial/set-top-level?host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}&action=${encodeURIComponent(action)}`;
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Netscape Bookmark File format (the de facto export/import standard every
// browser reads) -- plain regex parsing per bookmark row is enough, no HTML
// parser dependency needed for this shape.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function bookmarksToNetscapeHtml(bookmarks) {
  const items = bookmarks
    .map((b) => `    <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${Math.floor((b.addedAt || Date.now()) / 1000)}">${escapeHtml(b.title)}</A>`)
    .join("\n");
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${items}\n</DL><p>\n`;
}
function parseNetscapeBookmarks(html) {
  const out = [];
  const re = /<A[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].trim();
    if (/^https?:\/\//i.test(url)) out.push({ url, title: m[2].trim() || url });
  }
  return out;
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

    // Downloads/history/bookmarks are process-wide state (storage.js, one file
    // on disk), not per-window, so broadcast to every open window rather than
    // tracking which window's tab started the download.
    const send = (payload) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("celestial:downloads:event", { id, ...payload });
    };
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

// Builds the context menu for a right-click inside a tab's <webview>. Runs
// once per click (not wired at window scope) since it needs the specific
// webContents + click params (link/image/selection under the cursor).
function buildWebviewContextMenu(webContents, params) {
  const template = [
    { label: "Back", enabled: webContents.canGoBack(), click: () => webContents.goBack() },
    { label: "Forward", enabled: webContents.canGoForward(), click: () => webContents.goForward() },
    { label: "Reload", click: () => webContents.reload() },
    { type: "separator" },
  ];
  if (params.isEditable) {
    template.push(
      { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
      { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
      { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
    );
  } else if (params.selectionText) {
    template.push({ label: "Copy", role: "copy" }, { type: "separator" });
  }
  const ownerWin = BrowserWindow.fromWebContents(webContents.hostWebContents || webContents);
  if (params.linkURL) {
    template.push(
      { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
      { label: "Open link in new tab", click: () => ownerWin?.webContents.send("celestial:open-link-new-tab", params.linkURL) },
      { type: "separator" },
    );
  }
  if (params.mediaType === "image" && params.srcURL) {
    // Reuses the existing will-download flow (installDownloadHandler) --
    // downloadURL just triggers it, no separate save-as code needed.
    template.push({ label: "Save image as...", click: () => webContents.downloadURL(params.srcURL) }, { type: "separator" });
  }
  if (!app.isPackaged) {
    template.push({ label: "Inspect Element", click: () => webContents.inspectElement(params.x, params.y) });
  }
  Menu.buildFromTemplate(template).popup({ window: ownerWin || undefined });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0f1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  win.webContents.on("render-process-gone", (_event, details) => logCrash("render-process-gone", details));

  // Security guard for <webview>: discard any preload a compromised page tries
  // to smuggle in and pin our own fingerprint shim instead; only allow http(s)
  // targets, plus the exact local new-tab page (its own minimal, read-only
  // preload -- never the fingerprint shim, and never arbitrary file:// paths).
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
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
  win.webContents.on("did-attach-webview", (_event, webContents) => {
    webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    webContents.on("context-menu", (_e, params) => buildWebviewContextMenu(webContents, params));
  });
  console.log("[main] WebRTC disable_non_proxied_udp policy wired for webviews");

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

// Single application menu shared by every window (electron scopes it app-wide,
// not per-BrowserWindow). Menu bar itself stays hidden (autoHideMenuBar above)
// -- this only exists so the accelerators fire regardless of what has focus
// (chrome or a webview), which before-input-event on each webview can't do
// as robustly. Click handlers forward to the focused window's renderer over
// the celestial:shortcut channel; renderer.js and friends dispatch from there.
function buildAppMenu() {
  const send = (action) => (_menuItem, win) => win?.webContents.send("celestial:shortcut", action);
  const tabIndexItems = Array.from({ length: 8 }, (_, i) => ({
    label: `Tab ${i + 1}`, accelerator: `CommandOrControl+${i + 1}`, click: send(`tab-${i + 1}`),
  }));

  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "Celestial",
      submenu: [
        { label: "New Tab", accelerator: "CommandOrControl+T", click: send("new-tab") },
        { label: "Close Tab", accelerator: "CommandOrControl+W", click: send("close-tab") },
        { label: "Next Tab", accelerator: "CommandOrControl+Tab", click: send("next-tab") },
        { label: "Previous Tab", accelerator: "CommandOrControl+Shift+Tab", click: send("prev-tab") },
        { type: "separator" },
        { label: "Focus Address Bar", accelerator: "CommandOrControl+L", click: send("focus-address-bar") },
        { label: "Reload", accelerator: "CommandOrControl+R", click: send("reload") },
        { label: "Back", accelerator: "Alt+Left", click: send("back") },
        { label: "Forward", accelerator: "Alt+Right", click: send("forward") },
        { type: "separator" },
        ...tabIndexItems,
        { label: "Last Tab", accelerator: "CommandOrControl+9", click: send("tab-last") },
        { type: "separator" },
        { label: "Find in Page", accelerator: "CommandOrControl+F", click: send("find") },
        { label: "Print", accelerator: "CommandOrControl+P", click: send("print") },
        { label: "Zoom In", accelerator: "CommandOrControl+=", click: send("zoom-in") },
        { label: "Zoom In (alt)", accelerator: "CommandOrControl+Plus", click: send("zoom-in"), visible: false },
        { label: "Zoom Out", accelerator: "CommandOrControl+-", click: send("zoom-out") },
        { label: "Reset Zoom", accelerator: "CommandOrControl+0", click: send("zoom-reset") },
        { type: "separator" },
        { label: "History", accelerator: "CommandOrControl+H", click: send("history-panel") },
        { label: "Downloads", accelerator: "CommandOrControl+J", click: send("downloads-panel") },
        { label: "Bookmark Page", accelerator: "CommandOrControl+D", click: send("bookmark-current") },
        { type: "separator" },
        { label: "New Window", accelerator: "CommandOrControl+Shift+N", click: () => createWindow() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("celestial:set-top-level", (_event, host, action) => {
  if (typeof host !== "string" || !host) return false;
  return setProxyTopLevel(host, action === "remove" ? "remove" : "add");
});

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
ipcMain.handle("celestial:bookmarks:export", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: "bookmarks.html",
    filters: [{ name: "Netscape Bookmark File", extensions: ["html"] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, bookmarksToNetscapeHtml(storage.listBookmarks()));
  return { ok: true, filePath };
});
ipcMain.handle("celestial:bookmarks:import", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: "Bookmark HTML", extensions: ["html", "htm"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { ok: false, count: 0 };
  const parsed = parseNetscapeBookmarks(fs.readFileSync(filePaths[0], "utf8"));
  for (const b of parsed) storage.addBookmark(b);
  return { ok: true, count: parsed.length };
});

ipcMain.handle("celestial:extensions:list", () =>
  session.defaultSession.getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version })),
);
ipcMain.handle("celestial:extensions:install-ublock", async () => {
  try {
    const dir = await fetchUblock();
    const ext = await session.defaultSession.loadExtension(dir, { allowFileAccess: false });
    return { ok: true, name: ext.name, version: ext.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// Tab-strip right-click: renderer owns tab state (order, pinned), so the
// popup just reports back which action was picked over the same
// celestial:tab-context-menu:action channel renderer.js listens on -- it
// applies the actual close/duplicate/pin change itself.
ipcMain.on("celestial:tab-context-menu", (event, payload) => {
  if (!payload || typeof payload.id !== "string") return;
  const reply = (action) => event.sender.send("celestial:tab-context-menu:action", { id: payload.id, action });
  const template = [
    { label: "Close tab", click: () => reply("close") },
    { label: "Close other tabs", click: () => reply("close-others") },
    { label: "Duplicate tab", click: () => reply("duplicate") },
    { label: payload.pinned ? "Unpin tab" : "Pin tab", click: () => reply("toggle-pin") },
  ];
  const win = BrowserWindow.fromWebContents(event.sender);
  Menu.buildFromTemplate(template).popup({ window: win || undefined });
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
  buildAppMenu();
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
