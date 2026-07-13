"use strict";
// Loads unpacked Chrome extensions (e.g. uBlock Origin) into a session.
// No-ops cleanly if app/extensions/ is missing or has no valid extensions.

const fs = require("fs");
const path = require("path");

const EXT_DIR = path.join(__dirname, "extensions");

async function loadExtensions(ses) {
  if (!fs.existsSync(EXT_DIR)) return;

  const candidates = fs
    .readdirSync(EXT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(EXT_DIR, e.name, "manifest.json")));

  if (!candidates.length) {
    console.log("[extensions] no extensions found in app/extensions/, skipping");
    return;
  }

  for (const entry of candidates) {
    const dir = path.join(EXT_DIR, entry.name);
    try {
      const ext = await ses.loadExtension(dir, { allowFileAccess: false });
      console.log(`[extensions] loaded ${ext.name} (${ext.id}) from ${entry.name}`);
    } catch (err) {
      console.error(`[extensions] failed to load ${entry.name}:`, err.message);
    }
  }
}

module.exports = { loadExtensions };
