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

const tabs = new Map(); // id -> { webview, tabEl, url, host, lazy, suspended, lastActive }
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

// tabId defaults to the active tab -- every external caller (address bar,
// bookmarks panel) only ever navigates the currently active webview.
// materialize() passes its own id explicitly since it can run before the
// tab it's creating becomes active (see newTab()).
async function goTo(webview, rawUrl, tabId = activeId) {
  const url = normalizeUrl(rawUrl);
  // Local pages (new-tab start page) never go through the network proxy, so
  // there's no top-level host to register with the whitelist gate.
  if (!url.startsWith("file://")) {
    const hostname = new URL(url).hostname;
    await window.celestial.setTopLevel(hostname);
    const t = tabs.get(tabId);
    if (t) t.host = hostname;
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
    const snapshot = [...tabs.values()].map((t) => ({ url: t.url, pinned: !!t.pinned }));
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
  webview.addEventListener("page-favicon-updated", (e) => {
    const url = e.favicons && e.favicons[0];
    if (!url) return;
    t.faviconEl.style.backgroundImage = `url("${url}")`;
    t.faviconEl.classList.add("has-favicon");
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
  window.celestialWireFindEvents?.(webview);
  goTo(webview, t.url, id);
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
  const pinned = !!opts.pinned;
  const normalized = normalizeUrl(url || window.celestial.startPageUrl);

  const tabEl = document.createElement("div");
  tabEl.className = pinned ? "tab pinned" : "tab";
  tabEl.draggable = true;
  // tabEl.firstChild is relied on elsewhere as the label span -- favicon and
  // close button are appended after it (kept leftmost visually via CSS
  // `order`, not DOM position) so that invariant holds.
  const label = document.createElement("span");
  label.textContent = lazy && !normalized.startsWith("file://") ? new URL(normalized).hostname : "New Tab";
  tabEl.appendChild(label);
  tabEl.addEventListener("click", () => activate(id));

  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.appendChild(closeBtn);

  const faviconEl = document.createElement("span");
  faviconEl.className = "tab-favicon";
  tabEl.appendChild(faviconEl);

  wireTabDrag(id, tabEl);
  tabEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.celestial.showTabContextMenu({ id, pinned: !!tabs.get(id).pinned });
  });

  tabstripEl.insertBefore(tabEl, newTabBtn);

  tabs.set(id, {
    webview: null,
    tabEl,
    faviconEl,
    url: normalized,
    lazy,
    suspended: false,
    pinned,
    lastActive: Date.now(),
  });

  if (!lazy) materialize(id);
  if (opts.activate !== false) activate(id);
  scheduleSaveTabs();
  return id;
}

// ---------- drag-reorder + pinned tabs ----------

let dragSourceId = null;

function wireTabDrag(id, tabEl) {
  tabEl.addEventListener("dragstart", (e) => {
    dragSourceId = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  });
  tabEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  tabEl.addEventListener("dragenter", () => tabEl.classList.add("drag-over"));
  tabEl.addEventListener("dragleave", () => tabEl.classList.remove("drag-over"));
  tabEl.addEventListener("drop", (e) => {
    e.preventDefault();
    tabEl.classList.remove("drag-over");
    const draggedId = dragSourceId;
    dragSourceId = null;
    if (!draggedId || draggedId === id || !tabs.has(draggedId)) return;
    reorderTab(draggedId, id);
  });
}

// Moves draggedId to just before targetId, then re-applies the pinned-first
// invariant regardless of where the user actually dropped it.
function reorderTab(draggedId, targetId) {
  const order = [...tabs.keys()].filter((tid) => tid !== draggedId);
  order.splice(order.indexOf(targetId), 0, draggedId);
  applyTabOrder(order);
}

// Single source of truth for tab order: rebuilds the Map (which every
// iteration site -- activate, closeTab, checkIdleTabs, scheduleSaveTabs --
// already relies on for ordering) and repositions the DOM to match.
function applyTabOrder(order) {
  const pinned = order.filter((id) => tabs.get(id).pinned);
  const unpinned = order.filter((id) => !tabs.get(id).pinned);
  const sorted = [...pinned, ...unpinned];

  const rebuilt = new Map();
  for (const id of sorted) {
    const t = tabs.get(id);
    rebuilt.set(id, t);
    tabstripEl.insertBefore(t.tabEl, newTabBtn);
  }
  tabs.clear();
  for (const [id, t] of rebuilt) tabs.set(id, t);
  scheduleSaveTabs();
}

function togglePin(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.pinned = !t.pinned;
  t.tabEl.classList.toggle("pinned", t.pinned);
  applyTabOrder([...tabs.keys()]);
}

function closeOtherTabs(keepId) {
  for (const id of [...tabs.keys()]) {
    if (id !== keepId && !tabs.get(id).pinned) closeTab(id);
  }
}

function cycleTab(delta) {
  const ids = [...tabs.keys()];
  if (!ids.length) return;
  const idx = ids.indexOf(activeId);
  activate(ids[(idx + delta + ids.length) % ids.length]);
}

function activateTabByIndex(n) {
  const ids = [...tabs.keys()];
  const idx = n === "last" ? ids.length - 1 : n - 1;
  if (ids[idx]) activate(ids[idx]);
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
  // Un-register this tab's top-level host only if no other open tab still
  // uses it -- the proxy's whitelist gate is keyed by active top-levels,
  // not by tab, so a shared host must stay registered for the survivor.
  if (t.host && ![...tabs.values()].some((o) => o.host === t.host)) {
    window.celestial.setTopLevel(t.host, "remove").catch(() => {});
  }
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
    for (const t of saved) newTab(t.url, { lazy: true, activate: false, pinned: t.pinned });
  } else {
    newTab();
  }
})();

// ---------- keyboard shortcuts + context-menu actions from main ----------
// Accelerators live in main.js's application menu (works regardless of
// whether chrome or a webview has focus); this just dispatches the action
// string it forwards. Other shortcut actions (find/zoom/print, panel
// buttons, bookmark-current) are handled by their own files the same way.

window.celestial.onShortcut((action) => {
  const wv = activeWebview();
  if (action === "new-tab") newTab();
  else if (action === "close-tab") {
    const t = tabs.get(activeId);
    if (t && !t.pinned) closeTab(activeId);
  } else if (action === "next-tab") cycleTab(1);
  else if (action === "prev-tab") cycleTab(-1);
  else if (action === "focus-address-bar") { addressBar.focus(); addressBar.select(); }
  else if (action === "reload") wv?.reload();
  else if (action === "back") wv?.goBack();
  else if (action === "forward") wv?.goForward();
  else if (action.startsWith("tab-")) activateTabByIndex(action === "tab-last" ? "last" : Number(action.slice(4)));
});

window.celestial.onTabContextAction(({ id, action }) => {
  if (action === "close") closeTab(id);
  else if (action === "close-others") closeOtherTabs(id);
  else if (action === "duplicate") newTab(tabs.get(id)?.url);
  else if (action === "toggle-pin") togglePin(id);
});

window.celestial.onOpenLinkInNewTab((url) => newTab(url));
