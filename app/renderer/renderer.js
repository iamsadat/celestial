"use strict";

const viewsEl = document.getElementById("views");
const tabstripEl = document.getElementById("tabstrip");
const newTabBtn = document.getElementById("new-tab-btn");
const addressBar = document.getElementById("address-bar");
const backBtn = document.getElementById("back-btn");
const fwdBtn = document.getElementById("fwd-btn");
const reloadBtn = document.getElementById("reload-btn");
const statusPill = document.getElementById("status-pill");
const chromeEl = document.getElementById("chrome");

const tabs = new Map(); // id -> { webview, tabEl, url, lazy, suspended, lastActive }
let activeId = null;
let tabCounter = 0;

const IDLE_SUSPEND_MS = 60_000; // background tabs idle this long get discarded
const IDLE_CHECK_MS = 15_000;
let saveTabsTimer = null;

function normalizeUrl(input) {
  const v = input.trim();
  if (!v) return "https://example.com";
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

async function goTo(webview, rawUrl) {
  const url = normalizeUrl(rawUrl);
  // Local pages (new-tab start page) never go through the network proxy, so
  // there's no top-level host to register with the whitelist gate.
  if (!url.startsWith("file://")) {
    await window.celestial.setTopLevel(new URL(url).hostname);
  }
  if (webview.src) webview.loadURL(url);
  else webview.src = url;
}

function recordHistoryVisit(url) {
  if (!url || url === "about:blank" || url.startsWith("file://")) return;
  window.celestial.addHistory({ url }).catch(() => {});
}

// ponytail: debounce disk writes -- tabs change (nav/open/close) far more
// often than once per 400ms, and storage.js does a full-file JSON rewrite.
function scheduleSaveTabs() {
  clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(() => {
    const snapshot = [...tabs.values()].map((t) => ({ url: t.url }));
    window.celestial.saveTabs(snapshot).catch(() => {});
  }, 400);
}

function wireWebviewEvents(id, webview) {
  const t = tabs.get(id);
  webview.addEventListener("page-title-updated", (e) => {
    t.tabEl.firstChild.textContent = e.title || "New Tab";
  });
  webview.addEventListener("did-navigate", (e) => {
    t.url = e.url;
    if (id === activeId) addressBar.value = e.url;
    scheduleSaveTabs();
    recordHistoryVisit(e.url);
  });
  webview.addEventListener("did-navigate-in-page", (e) => {
    t.url = e.url;
    if (id === activeId) addressBar.value = e.url;
    recordHistoryVisit(e.url);
  });
}

// Turns a placeholder (lazy or freshly created) tab entry into a real
// <webview> and navigates it. No-ops if already materialized.
function materialize(id) {
  const t = tabs.get(id);
  if (!t || t.webview) return;
  const webview = document.createElement("webview");
  webview.setAttribute("allowpopups", "false");
  viewsEl.appendChild(webview);
  t.webview = webview;
  wireWebviewEvents(id, webview);
  goTo(webview, t.url);
  t.lazy = false;
}

function restoreSuspended(id) {
  const t = tabs.get(id);
  if (!t || !t.suspended) return;
  t.webview.src = t.url;
  t.suspended = false;
  t.tabEl.classList.remove("suspended");
}

function suspendTab(id) {
  const t = tabs.get(id);
  if (!t || !t.webview || t.suspended) return;
  t.url = t.webview.src || t.url;
  // ponytail: no native webview "discard" API -- navigating to about:blank
  // frees the backgrounded page's renderer memory while keeping the
  // <webview> element/process alive for a fast restore on refocus.
  t.webview.src = "about:blank";
  t.suspended = true;
  t.tabEl.classList.add("suspended");
}

function checkIdleTabs() {
  const now = Date.now();
  for (const [id, t] of tabs) {
    if (id === activeId || t.lazy || t.suspended || !t.webview) continue;
    if (now - t.lastActive > IDLE_SUSPEND_MS) suspendTab(id);
  }
}
setInterval(checkIdleTabs, IDLE_CHECK_MS);

function newTab(url, opts = {}) {
  const id = `tab-${++tabCounter}`;
  const lazy = !!opts.lazy;
  const normalized = normalizeUrl(url || window.celestial.startPageUrl);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  const label = document.createElement("span");
  label.textContent = lazy && !normalized.startsWith("file://") ? new URL(normalized).hostname : "New Tab";
  tabEl.appendChild(label);
  tabEl.addEventListener("click", () => activate(id));

  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.appendChild(closeBtn);

  tabstripEl.insertBefore(tabEl, newTabBtn);

  tabs.set(id, {
    webview: null,
    tabEl,
    url: normalized,
    lazy,
    suspended: false,
    lastActive: Date.now(),
  });

  if (!lazy) materialize(id);
  if (opts.activate !== false) activate(id);
  scheduleSaveTabs();
  return id;
}

function activate(id) {
  const prev = tabs.get(activeId);
  if (prev) prev.lastActive = Date.now();

  activeId = id;
  const t = tabs.get(id);
  if (t) {
    if (t.lazy) materialize(id);
    else if (t.suspended) restoreSuspended(id);
    t.lastActive = Date.now();
  }

  for (const [tid, tab] of tabs) {
    if (tab.webview) tab.webview.classList.toggle("active", tid === id);
    tab.tabEl.classList.toggle("active", tid === id);
  }
  if (t) addressBar.value = t.url;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.webview) t.webview.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length) activate(remaining[remaining.length - 1]);
    else newTab();
  }
  scheduleSaveTabs();
}

function activeWebview() {
  const t = tabs.get(activeId);
  return t ? t.webview : null;
}

// Exposed for bookmarks-panel.js -- same-process DOM/state, no IPC needed.
window.celestialActiveWebview = activeWebview;
window.celestialGoTo = goTo;

// Shared by every slide-in panel script (bookmarks/settings/downloads/history)
// so opening one closes the others instead of stacking.
const PANEL_IDS = ["bookmarks-panel", "settings-panel", "downloads-panel", "history-panel"];
window.celestialClosePanels = (exceptId) => {
  for (const id of PANEL_IDS) {
    if (id !== exceptId) document.getElementById(id)?.classList.add("hidden");
  }
};

newTabBtn.addEventListener("click", () => newTab());
backBtn.addEventListener("click", () => activeWebview()?.goBack());
fwdBtn.addEventListener("click", () => activeWebview()?.goForward());
reloadBtn.addEventListener("click", () => activeWebview()?.reload());
addressBar.addEventListener("keydown", (e) => {
  const wv = activeWebview();
  if (e.key === "Enter" && wv) goTo(wv, addressBar.value);
});

function applyStatus(healthy) {
  statusPill.classList.toggle("offline", !healthy);
  statusPill.title = healthy ? "Secure -- tunnel healthy" : "Offline -- tunnel down";
  statusPill.setAttribute("aria-label", statusPill.title);
  chromeEl.classList.toggle("offline", !healthy);
  addressBar.placeholder = healthy
    ? "Search or enter address"
    : "Traffic frozen -- tunnel down. Reconnect to browse.";
}

async function pollStatus() {
  try {
    const s = await window.celestial.getStatus();
    applyStatus(!!s.tunnel_healthy);
  } catch {
    applyStatus(false);
  }
}
setInterval(pollStatus, 3000);
pollStatus();

// Startup: restore tabs from the encrypted store as lazy placeholders -- no
// webview, no network -- until the user actually clicks one. Falls back to
// a single fresh tab if nothing was saved (or storage isn't reachable).
(async function restoreOrStartFresh() {
  let saved = [];
  try {
    saved = await window.celestial.getTabs();
  } catch {}
  if (Array.isArray(saved) && saved.length) {
    for (const t of saved) newTab(t.url, { lazy: true, activate: false });
  } else {
    newTab();
  }
})();
