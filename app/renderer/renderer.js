"use strict";

const viewsEl = document.getElementById("views");
const tabstripEl = document.getElementById("tabstrip");
const newTabBtn = document.getElementById("new-tab-btn");
const addressBar = document.getElementById("address-bar");
const backBtn = document.getElementById("back-btn");
const fwdBtn = document.getElementById("fwd-btn");
const reloadBtn = document.getElementById("reload-btn");
const statusPill = document.getElementById("status-pill");

const tabs = new Map(); // id -> { webview, tabEl }
let activeId = null;
let tabCounter = 0;

function normalizeUrl(input) {
  const v = input.trim();
  if (!v) return "https://example.com";
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

async function goTo(webview, rawUrl) {
  const url = normalizeUrl(rawUrl);
  // Proxy whitelist gate needs to know the host before the request lands.
  await window.celestial.setTopLevel(new URL(url).hostname);
  if (webview.src) webview.loadURL(url);
  else webview.src = url;
}

function newTab(url) {
  const id = `tab-${++tabCounter}`;

  const webview = document.createElement("webview");
  webview.setAttribute("allowpopups", "false");
  viewsEl.appendChild(webview);
  goTo(webview, url || "https://example.com");

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.textContent = "New Tab";
  tabEl.addEventListener("click", () => activate(id));

  const closeBtn = document.createElement("span");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id); });
  tabEl.appendChild(closeBtn);

  tabstripEl.insertBefore(tabEl, newTabBtn);

  webview.addEventListener("page-title-updated", (e) => {
    tabEl.textContent = e.title || "New Tab";
    tabEl.appendChild(closeBtn);
  });
  webview.addEventListener("did-navigate", (e) => {
    if (id === activeId) addressBar.value = e.url;
  });
  webview.addEventListener("did-navigate-in-page", (e) => {
    if (id === activeId) addressBar.value = e.url;
  });

  tabs.set(id, { webview, tabEl });
  activate(id);
  return id;
}

function activate(id) {
  activeId = id;
  for (const [tid, t] of tabs) {
    t.webview.classList.toggle("active", tid === id);
    t.tabEl.classList.toggle("active", tid === id);
  }
  const active = tabs.get(id);
  if (active) addressBar.value = active.webview.src;
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.webview.remove();
  t.tabEl.remove();
  tabs.delete(id);
  if (activeId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length) activate(remaining[remaining.length - 1]);
    else newTab();
  }
}

function activeWebview() {
  const t = tabs.get(activeId);
  return t ? t.webview : null;
}

newTabBtn.addEventListener("click", () => newTab());
backBtn.addEventListener("click", () => activeWebview()?.goBack());
fwdBtn.addEventListener("click", () => activeWebview()?.goForward());
reloadBtn.addEventListener("click", () => activeWebview()?.reload());
addressBar.addEventListener("keydown", (e) => {
  const wv = activeWebview();
  if (e.key === "Enter" && wv) goTo(wv, addressBar.value);
});

async function pollStatus() {
  try {
    const s = await window.celestial.getStatus();
    statusPill.textContent = s.tunnel_healthy ? "SECURE" : "OFFLINE";
    statusPill.className = "status-pill " + (s.tunnel_healthy ? "secure" : "offline");
  } catch {
    statusPill.textContent = "OFFLINE";
    statusPill.className = "status-pill offline";
  }
}
setInterval(pollStatus, 3000);
pollStatus();

newTab("https://example.com");
