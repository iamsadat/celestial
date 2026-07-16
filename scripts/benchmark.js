#!/usr/bin/env node
"use strict";
// Cold-start + RAM baseline for the Celestial Electron shell, plus an
// optional side-by-side comparison against a system Chrome/Chromium install.
// ponytail: shells out to /proc instead of a perf-measurement lib -- stdlib
// + Linux's own process tree accounting is enough to sum RSS across the
// app's main/renderer/GPU/sidecar processes. Linux-only (WSL/Linux is what
// this runs on); add a `ps`-based fallback if this needs to run on macOS.
// Run: node scripts/benchmark.js

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "app");
const ELECTRON_BIN = path.join(APP_DIR, "node_modules", ".bin", "electron");
const READY_MARKER = "[main] WebRTC disable_non_proxied_udp policy wired for webviews";
const READY_TIMEOUT_MS = 20_000;
const SETTLE_MS = 4_000; // let the default tab finish loading before sampling RAM
const DISPLAY_NUM = ":97"; // ponytail: fixed unused display; bump if it collides
const CHROME_DEBUG_PORT = 9333;

function haveBin(bin) {
  return spawnSync("which", [bin]).status === 0;
}

// Builds a pid -> ppid map from /proc and BFS's out from rootPid.
function descendantPids(rootPid) {
  const pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  const ppidOf = new Map();
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/\)\s+\S\s+(\d+)/); // ppid follows "(comm) state"
      if (m) ppidOf.set(Number(pid), Number(m[1]));
    } catch {} // process exited between readdir and read
  }
  const result = [rootPid];
  let frontier = [rootPid];
  while (frontier.length) {
    frontier = [...ppidOf.entries()].filter(([, ppid]) => frontier.includes(ppid)).map(([pid]) => pid);
    result.push(...frontier);
  }
  return result;
}

function rssKbOf(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s+(\d+) kB/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0; // process already exited
  }
}

function killTree(pids) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

async function measureElectron(env) {
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error(`electron binary not found at ${ELECTRON_BIN} - run npm install in app/ first`);
    return null;
  }

  const start = Date.now();
  let readyAt = null;
  const child = spawn(ELECTRON_BIN, ["."], { cwd: APP_DIR, env });

  const onOutput = (buf) => {
    if (!readyAt && buf.toString().includes(READY_MARKER)) readyAt = Date.now();
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);

  const booted = await Promise.race([
    new Promise((resolve) => {
      const iv = setInterval(() => {
        if (readyAt) { clearInterval(iv); resolve(true); }
      }, 100);
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), READY_TIMEOUT_MS)),
  ]);

  if (!booted) {
    console.error(`electron did not reach ready marker within ${READY_TIMEOUT_MS}ms - aborting`);
    child.kill();
    return null;
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const pids = descendantPids(child.pid);
  const totalRssMb = pids.reduce((sum, pid) => sum + rssKbOf(pid), 0) / 1024;
  killTree(pids);

  return { label: "Celestial (Electron)", coldStartMs: readyAt - start, processCount: pids.length, totalRssMb };
}

// Finds a Chrome/Chromium binary via PATH first, then a few common install
// locations. Returns null if nothing is found -- callers skip gracefully.
function findChromeBinary() {
  for (const bin of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"]) {
    const r = spawnSync("which", [bin]);
    if (r.status === 0) return r.stdout.toString().trim();
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Readiness signal mirrors the Electron side's log-marker approach: Chrome
// has no equivalent stdout marker, so poll its own remote-debugging endpoint
// (--remote-debugging-port) until it answers, same idea as READY_MARKER.
async function waitForChromeReady(port, deadline) {
  return new Promise((resolve) => {
    const poll = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 1000 }, (res) => {
        res.resume();
        resolve(Date.now());
      });
      req.on("error", () => {
        if (Date.now() > deadline) resolve(null);
        else setTimeout(poll, 100);
      });
      req.on("timeout", () => req.destroy());
    };
    poll();
  });
}

async function measureChrome(env) {
  const bin = findChromeBinary();
  if (!bin) {
    console.log("no Chrome/Chromium binary found on PATH or common install locations - skipping comparison");
    return null;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "celestial-bench-chrome-"));
  const start = Date.now();
  const child = spawn(bin, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ], { env, stdio: "ignore" });

  const readyAt = await waitForChromeReady(CHROME_DEBUG_PORT, Date.now() + READY_TIMEOUT_MS);

  if (!readyAt) {
    console.error(`chrome did not become ready within ${READY_TIMEOUT_MS}ms - skipping comparison`);
    child.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    return null;
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const pids = descendantPids(child.pid);
  const totalRssMb = pids.reduce((sum, pid) => sum + rssKbOf(pid), 0) / 1024;
  killTree(pids);
  fs.rmSync(userDataDir, { recursive: true, force: true });

  return { label: `Chrome/Chromium (${path.basename(bin)})`, coldStartMs: readyAt - start, processCount: pids.length, totalRssMb };
}

function printResult(r) {
  console.log(`\n${r.label}`);
  console.log("-".repeat(r.label.length));
  console.log(`cold start (spawn -> ready):    ${r.coldStartMs} ms`);
  console.log(`process count (main+children):  ${r.processCount}`);
  console.log(`total RSS:                       ${r.totalRssMb.toFixed(1)} MB`);
}

async function main() {
  const env = { ...process.env };
  let xvfb = null;
  if (!env.DISPLAY) {
    if (!haveBin("Xvfb")) {
      console.error("no DISPLAY and no Xvfb available - can't boot headless here. Skipping benchmark.");
      process.exit(0);
    }
    xvfb = spawn("Xvfb", [DISPLAY_NUM, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
    env.DISPLAY = DISPLAY_NUM;
    await new Promise((r) => setTimeout(r, 500)); // give Xvfb time to bind
  }

  console.log("Celestial cold-start benchmark");
  const electronResult = await measureElectron(env);
  if (electronResult) printResult(electronResult);

  const chromeResult = await measureChrome(env);
  if (chromeResult) printResult(chromeResult);

  if (electronResult && chromeResult) {
    console.log("\nSide-by-side");
    console.log("------------");
    console.log(`cold start:  Celestial ${electronResult.coldStartMs} ms  vs  Chrome ${chromeResult.coldStartMs} ms`);
    console.log(`total RSS:   Celestial ${electronResult.totalRssMb.toFixed(1)} MB  vs  Chrome ${chromeResult.totalRssMb.toFixed(1)} MB`);
  } else {
    console.log("\nReference: a single idle Chrome tab commonly sits at 100-250MB RSS alone.");
  }

  if (xvfb) xvfb.kill();
  if (!electronResult) process.exit(1);
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
