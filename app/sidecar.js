"use strict";
// Spawns and health-checks the Python sidecar (API :8765 + privacy proxy :8080).
// Reuses core/api_server.py and core/custom_proxy.py's existing __main__ entrypoints as-is.

const { app } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const path = require("path");

// Packaged builds ship core/ + requirements.txt via electron-builder's
// extraResources (see app/package.json "build.extraResources"), copied to
// process.resourcesPath instead of living next to app.asar. Dev/unpackaged
// runs keep using the real repo root.
// ponytail: no bundled python runtime -- the installer expects a system
// python3 with `pip install -r requirements.txt` already run. Bundling a
// full interpreter (PyInstaller etc.) is future work if that's ever a problem.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const PYTHON = process.env.CELESTIAL_PYTHON || "python3";
const API_PORT = 8765;
const PROXY_PORT = 8080;

let apiProc = null;
let proxyProc = null;

function checkPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host, timeout: 1000 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function checkApiHealthy() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${API_PORT}/status`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(checkFn, timeoutMs = 15000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkFn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function spawnChild(scriptRelPath, label) {
  // PYTHONUNBUFFERED: this proxy's whole job is its audit log; buffered stdout
  // (Python's default when not attached to a TTY) can sit unflushed for a while.
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  const proc = spawn(PYTHON, [scriptRelPath], { cwd: REPO_ROOT, stdio: "inherit", env });
  proc.on("exit", (code) => console.log(`[sidecar] ${label} exited (${code})`));
  proc.on("error", (err) => console.error(`[sidecar] ${label} failed to spawn:`, err.message));
  return proc;
}

async function start() {
  if (await checkApiHealthy()) {
    console.log("[sidecar] API already running on :8765, reusing it");
  } else {
    apiProc = spawnChild("core/api_server.py", "api_server");
    const healthy = await waitFor(checkApiHealthy);
    if (!healthy) throw new Error("Celestial API sidecar failed health check within timeout");
    console.log("[sidecar] API healthy on :8765");
  }

  if (await checkPort(PROXY_PORT)) {
    console.log("[sidecar] proxy already listening on :8080, reusing it");
  } else {
    proxyProc = spawnChild("core/custom_proxy.py", "custom_proxy");
    // ponytail: custom_proxy.py exposes no /health endpoint, only a TCP listener.
    // Poll the port instead of a fixed sleep so we don't race a slow start.
    const up = await waitFor(() => checkPort(PROXY_PORT), 10000, 200);
    if (!up) throw new Error("Celestial privacy proxy failed to bind :8080 within timeout");
    console.log("[sidecar] proxy listening on :8080");
  }
}

function stop() {
  for (const p of [apiProc, proxyProc]) {
    if (p && !p.killed) p.kill();
  }
}

module.exports = { start, stop, checkApiHealthy, checkPort };
