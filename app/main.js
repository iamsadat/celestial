"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const sidecar = require("./sidecar");

const CONTROL_TOKEN_PATH = path.join(__dirname, "..", "desktop", "config", ".api_token");

// Tells the proxy sidecar which host the user is navigating to, so its
// whitelist gate (core/custom_proxy.py's is_request_allowed) allows it.
// See custom_proxy.py's _handle_control for why this exists and is token-gated.
function setProxyTopLevel(host) {
  return new Promise((resolve) => {
    let token;
    try {
      token = fs.readFileSync(CONTROL_TOKEN_PATH, "utf8").trim();
    } catch {
      return resolve(false);
    }
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
  // targets.
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, "fingerprint-preload.js");
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//.test(params.src) && params.src !== "about:blank") {
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

app.whenReady().then(async () => {
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

  installPrivacyHandlers();
  installKillSwitchWatcher();
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
