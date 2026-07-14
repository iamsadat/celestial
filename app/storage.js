"use strict";
// Encrypted local store for bookmarks + history + open tabs.
// ponytail: crypto + JSON instead of better-sqlite3 — no native module, no
// WSL build headaches, and this data is tiny (KBs, not rows-at-scale).
// Upgrade to SQLite only if bookmark/history counts start needing real
// queries a linear scan can't do.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const ALGO = "aes-256-gcm";

let storePath, keyPath, key, state;

function loadKey() {
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    if (safeStorage.isEncryptionAvailable()) {
      return Buffer.from(safeStorage.decryptString(raw), "hex");
    }
    return Buffer.from(raw.toString("utf8"), "hex");
  }
  const fresh = crypto.randomBytes(32);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyPath, safeStorage.encryptString(fresh.toString("hex")));
    console.log("[storage] key sealed via OS safeStorage");
  } else {
    fs.writeFileSync(keyPath, fresh.toString("hex"), { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600); // writeFileSync's mode is masked by umask; force it
    console.log("[storage] safeStorage unavailable — key written to keyfile (0600)");
  }
  return fresh;
}

function encryptBuf(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]); // iv(12) | tag(16) | ciphertext
}

function decryptBuf(blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function persist() {
  fs.writeFileSync(storePath, encryptBuf(Buffer.from(JSON.stringify(state))));
}

function init() {
  storePath = path.join(app.getPath("userData"), "celestial-store.enc");
  keyPath = path.join(app.getPath("userData"), "celestial.key");
  key = loadKey();

  if (fs.existsSync(storePath)) {
    try {
      state = JSON.parse(decryptBuf(fs.readFileSync(storePath)).toString("utf8"));
      if (!Array.isArray(state.downloads)) state.downloads = []; // migrate older stores
      console.log("[storage] loaded existing encrypted store");
    } catch (err) {
      console.error("[storage] failed to decrypt existing store, starting fresh:", err.message);
      state = { bookmarks: [], history: [], tabs: [], downloads: [] };
    }
  } else {
    state = { bookmarks: [], history: [], tabs: [], downloads: [] };
    persist();
    console.log("[storage] initialized new encrypted store at", storePath);
  }
}

// --- bookmarks ---
function listBookmarks() {
  return state.bookmarks;
}
function addBookmark({ url, title }) {
  const b = { id: crypto.randomUUID(), url, title: title || url, addedAt: Date.now() };
  state.bookmarks.push(b);
  persist();
  return b;
}
function deleteBookmark(id) {
  state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
  persist();
}

// --- history ---
const HISTORY_CAP = 5000;
function recordHistory({ url, title }) {
  const h = { id: crypto.randomUUID(), url, title: title || url, visitedAt: Date.now() };
  state.history.push(h);
  if (state.history.length > HISTORY_CAP) state.history = state.history.slice(-HISTORY_CAP);
  persist();
  return h;
}
function listHistory() {
  return state.history.slice().reverse();
}
function clearHistory() {
  state.history = [];
  persist();
}
function deleteHistoryEntry(id) {
  state.history = state.history.filter((h) => h.id !== id);
  persist();
}

// --- open tabs (data model only for now) ---
// ponytail: no IPC/UI wired up — nothing calls this yet, and wiring "restore
// tabs on launch" touches renderer.js, which Phase C owns this pass. Kept as
// plain get/set so a future restore-session feature is a one-file change.
function saveOpenTabs(tabs) {
  state.tabs = tabs;
  persist();
}
function getOpenTabs() {
  return state.tabs;
}

// --- downloads: completed-download history only (in-progress state lives in
// renderer memory via IPC events; only finished items get persisted) ---
function addDownload({ filename, path: filePath, url, size }) {
  const d = { id: crypto.randomUUID(), filename, path: filePath, url, size, completedAt: Date.now() };
  state.downloads.push(d);
  persist();
  return d;
}
function listDownloads() {
  return state.downloads.slice().reverse();
}

// --- sync: design now, build later ---
// Future: a dumb blob store server. The client (this module) always
// encrypts locally before any upload — the server never sees plaintext or
// the key, it just stores/returns opaque blobs keyed by account. These two
// calls are exactly what a future sync client would wrap with an HTTP
// PUT/GET; no server exists yet.
function exportEncrypted() {
  return encryptBuf(Buffer.from(JSON.stringify(state)));
}
function importEncrypted(blob) {
  state = JSON.parse(decryptBuf(blob).toString("utf8"));
  persist();
}

module.exports = {
  init,
  listBookmarks,
  addBookmark,
  deleteBookmark,
  recordHistory,
  listHistory,
  clearHistory,
  deleteHistoryEntry,
  saveOpenTabs,
  getOpenTabs,
  addDownload,
  listDownloads,
  exportEncrypted,
  importEncrypted,
};
