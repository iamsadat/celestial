"use strict";
// Minimal bookmarks UI: a toggled dropdown listing saved bookmarks, with an
// add-current-page row and per-item remove. Only talks to the main process
// via the celestial.* IPC bridge from preload.js and the window.celestial*
// globals renderer.js exposes -- no direct storage/webview access from here.

const bookmarkBtn = document.getElementById("bookmark-btn");
const panel = document.getElementById("bookmarks-panel");
const addRow = document.getElementById("bookmarks-add-row");
const listEl = document.getElementById("bookmarks-list");

async function renderBookmarks() {
  const bookmarks = await window.celestial.getBookmarks();
  listEl.innerHTML = "";
  if (!bookmarks.length) {
    const empty = document.createElement("div");
    empty.className = "bookmarks-empty";
    empty.textContent = "No bookmarks yet";
    listEl.appendChild(empty);
    return;
  }
  for (const b of bookmarks) {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    row.title = b.url;

    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = b.title;
    title.addEventListener("click", () => {
      const wv = window.celestialActiveWebview();
      if (wv) window.celestialGoTo(wv, b.url);
      panel.classList.add("hidden");
    });

    const remove = document.createElement("span");
    remove.className = "bookmark-remove";
    remove.textContent = "×";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.celestial.deleteBookmark(b.id);
      renderBookmarks();
    });

    row.appendChild(title);
    row.appendChild(remove);
    listEl.appendChild(row);
  }
}

addRow.addEventListener("click", async () => {
  const wv = window.celestialActiveWebview();
  if (!wv || !wv.src) return;
  await window.celestial.addBookmark({ url: wv.src, title: wv.getTitle() || wv.src });
  renderBookmarks();
});

bookmarkBtn.addEventListener("click", () => {
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) window.celestialClosePanels("bookmarks-panel");
  panel.classList.toggle("hidden");
  if (isHidden) renderBookmarks();
});

document.addEventListener("click", (e) => {
  if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== bookmarkBtn) {
    panel.classList.add("hidden");
  }
});

window.celestial.onShortcut(async (action) => {
  if (action !== "bookmark-current") return;
  const wv = window.celestialActiveWebview();
  if (!wv || !wv.src) return;
  await window.celestial.addBookmark({ url: wv.src, title: wv.getTitle() || wv.src });
  if (!panel.classList.contains("hidden")) renderBookmarks();
});
