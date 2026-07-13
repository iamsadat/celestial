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

let mainWindow = null;

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

  // Security guard for <webview>: strip any preload/nodeIntegration a
  // compromised page could try to smuggle in, and only allow http(s) targets.
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//.test(params.src) && params.src !== "about:blank") {
      event.preventDefault();
    }
  });

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
    proxyRules: "http=127.0.0.1:8080;https=127.0.0.1:8080",
    proxyBypassRules: "<-loopback>",
  });
  console.log("[main] proxy applied:", await session.defaultSession.resolveProxy("https://example.com"));

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
