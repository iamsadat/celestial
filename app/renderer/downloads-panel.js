"use strict";
// Downloads panel: live progress for in-flight downloads (via celestial.onDownloadEvent,
// pushed from main's will-download handler) plus the persisted completed list.

const downloadsBtn = document.getElementById("downloads-btn");
const downloadsPanel = document.getElementById("downloads-panel");
const downloadsListEl = document.getElementById("downloads-list");

const active = new Map(); // id -> { row, fill, meta, filename, path }

function fmtBytes(n) {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${units[i]}`;
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "download-row";
  row.title = entry.path || "";

  const name = document.createElement("div");
  name.className = "download-name";
  name.textContent = entry.filename;

  const bar = document.createElement("div");
  bar.className = "download-bar";
  const fill = document.createElement("div");
  fill.className = "download-bar-fill";
  bar.appendChild(fill);

  const meta = document.createElement("div");
  meta.className = "download-meta";

  row.appendChild(name);
  row.appendChild(bar);
  row.appendChild(meta);

  row.addEventListener("click", () => {
    if (entry.path) window.celestial.showDownload(entry.path);
  });

  return { row, fill, meta };
}

function upsertActive(evt) {
  let entry = active.get(evt.id);
  if (!entry) {
    const { row, fill, meta } = renderRow({ filename: evt.filename, path: evt.path });
    downloadsListEl.prepend(row);
    entry = { row, fill, meta, filename: evt.filename, path: evt.path };
    active.set(evt.id, entry);
  }
  if (evt.filename) entry.filename = evt.filename;
  if (evt.path) { entry.path = evt.path; entry.row.title = evt.path; }

  if (evt.state === "started") {
    entry.meta.textContent = "Starting...";
  } else if (evt.state === "progressing" && evt.totalBytes > 0) {
    const pct = Math.min(100, Math.round((evt.receivedBytes / evt.totalBytes) * 100));
    entry.fill.style.width = `${pct}%`;
    entry.meta.textContent = `${fmtBytes(evt.receivedBytes)} / ${fmtBytes(evt.totalBytes)}`;
  } else if (evt.state === "completed") {
    entry.fill.style.width = "100%";
    entry.row.classList.add("download-done");
    entry.meta.textContent = "Done";
  } else if (evt.state === "cancelled" || evt.state === "interrupted") {
    entry.row.classList.add("download-failed");
    entry.meta.textContent = "Failed";
  }
}

window.celestial.onDownloadEvent(upsertActive);

async function refreshDownloadsList() {
  downloadsListEl.innerHTML = "";
  const activePaths = new Set();
  for (const entry of active.values()) {
    downloadsListEl.appendChild(entry.row);
    if (entry.path) activePaths.add(entry.path);
  }

  // Completed active entries are already persisted by main -- skip the
  // duplicate row that listDownloads() would otherwise add for the same file.
  const items = await window.celestial.listDownloads();
  for (const d of items) {
    if (activePaths.has(d.path)) continue;
    const { row, fill, meta } = renderRow(d);
    fill.style.width = "100%";
    meta.textContent = "Done";
    row.classList.add("download-done");
    downloadsListEl.appendChild(row);
  }

  if (!downloadsListEl.children.length) {
    const empty = document.createElement("div");
    empty.className = "downloads-empty";
    empty.textContent = "No downloads yet";
    downloadsListEl.appendChild(empty);
  }
}

downloadsBtn.addEventListener("click", () => {
  const isHidden = downloadsPanel.classList.contains("hidden");
  if (isHidden) window.celestialClosePanels("downloads-panel");
  downloadsPanel.classList.toggle("hidden");
  if (isHidden) refreshDownloadsList();
});

document.addEventListener("click", (e) => {
  if (!downloadsPanel.classList.contains("hidden") && !downloadsPanel.contains(e.target) && e.target !== downloadsBtn) {
    downloadsPanel.classList.add("hidden");
  }
});

window.celestial.onShortcut((action) => {
  if (action === "downloads-panel") downloadsBtn.click();
});
