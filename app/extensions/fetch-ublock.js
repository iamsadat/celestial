#!/usr/bin/env node
"use strict";
// Downloads uBlock Origin's Chromium release zip and unpacks it here so
// app/extensions.js picks it up on next launch. Exported as fetchUblock()
// so main.js's "Install uBlock Origin" button can call it directly; also
// runnable standalone (`node fetch-ublock.js`). The binary isn't vendored
// into git. See README.md.

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RELEASES_API = "https://api.github.com/repos/gorhill/uBlock/releases/latest";
const ZIP_PATH = path.join(__dirname, "ublock-origin.zip");
const UNPACK_DIR = path.join(__dirname, "ublock-origin");

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "celestial-fetch-ublock" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(get(res.headers.location));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

// Returns UNPACK_DIR on success (the directory to session.loadExtension()).
async function fetchUblock() {
  console.log("[fetch-ublock] querying latest release...");
  const meta = JSON.parse((await get(RELEASES_API)).toString("utf8"));
  const asset = meta.assets.find((a) => /chromium\.zip$/i.test(a.name));
  if (!asset) throw new Error("no *.chromium.zip asset found in latest release");

  console.log(`[fetch-ublock] downloading ${asset.name}...`);
  fs.writeFileSync(ZIP_PATH, await get(asset.browser_download_url));

  fs.rmSync(UNPACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(UNPACK_DIR, { recursive: true });
  execFileSync("unzip", ["-q", ZIP_PATH, "-d", UNPACK_DIR], { stdio: "inherit" });
  fs.unlinkSync(ZIP_PATH);

  console.log(`[fetch-ublock] unpacked to ${UNPACK_DIR}`);
  return UNPACK_DIR;
}

module.exports = { fetchUblock, UNPACK_DIR };

if (require.main === module) {
  fetchUblock().catch((err) => {
    console.error("[fetch-ublock] failed:", err.message);
    console.error("Manual fallback: download the *.chromium.zip asset from");
    console.error("https://github.com/gorhill/uBlock/releases/latest and unzip it into");
    console.error(UNPACK_DIR);
    process.exit(1);
  });
}
