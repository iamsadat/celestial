#!/usr/bin/env node
"use strict";
// Cold-start + RAM baseline for the Celestial Electron shell.
// ponytail: shells out to /proc instead of a perf-measurement lib -- stdlib
// + Linux's own process tree accounting is enough to sum RSS across the
// app's main/renderer/GPU/sidecar processes. Linux-only (WSL/Linux is what
// this runs on); add a `ps`-based fallback if this needs to run on macOS.
// Run: node scripts/benchmark.js

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "app");
const ELECTRON_BIN = path.join(APP_DIR, "node_modules", ".bin", "electron");
const READY_MARKER = "[main] WebRTC disable_non_proxied_udp policy wired for webviews";
const READY_TIMEOUT_MS = 20_000;
const SETTLE_MS = 4_000; // let the default tab finish loading before sampling RAM
const DISPLAY_NUM = ":97"; // ponytail: fixed unused display; bump if it collides

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

async function main() {
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error(`electron binary not found at ${ELECTRON_BIN} - run npm install in app/ first`);
    process.exit(1);
  }

  const env = { ...process.env };
  let xvfb = null;
  if (!env.DISPLAY) {
    if (!haveBin("Xvfb")) {
      console.error("no DISPLAY and no Xvfb available - can't boot Electron headless here. Skipping benchmark.");
      process.exit(0);
    }
    xvfb = spawn("Xvfb", [DISPLAY_NUM, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
    env.DISPLAY = DISPLAY_NUM;
    await new Promise((r) => setTimeout(r, 500)); // give Xvfb time to bind
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
    console.error(`app did not reach ready marker within ${READY_TIMEOUT_MS}ms - aborting benchmark`);
    child.kill();
    if (xvfb) xvfb.kill();
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));

  const pids = descendantPids(child.pid);
  const totalRssMb = pids.reduce((sum, pid) => sum + rssKbOf(pid), 0) / 1024;

  console.log("\nCelestial cold-start benchmark");
  console.log("------------------------------");
  console.log(`cold start (spawn -> ready):    ${readyAt - start} ms`);
  console.log(`process count (main+children):  ${pids.length}`);
  console.log(`total RSS:                       ${totalRssMb.toFixed(1)} MB`);
  console.log("------------------------------");
  console.log("Reference: a single idle Chrome tab commonly sits at 100-250MB RSS alone.");

  // Kill the whole descendant tree ourselves (sidecar python procs included)
  // rather than relying on SIGTERM cascading through Electron's own cleanup.
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  if (xvfb) xvfb.kill();
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
