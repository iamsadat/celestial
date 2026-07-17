"use strict";
// Minimal bookmarks UI: a toggled dropdown listing saved bookmarks, with an
// add-current-page row and per-item remove. Only talks to the main process
// via the celestial.* IPC bridge from preload.js and the window.celestial*
// globals renderer.js exposes -- no direct storage/webview access from here.

const bookmarkBtn = document.getElementById("bookmark-btn");
const bookmarksPanel = document.getElementById("bookmarks-panel");
const addRow = document.getElementById("bookmarks-add-row");
const listEl = document.getElementById("bookmarks-list");
const exportBtn = document.getElementById("bookmarks-export-btn");
const importBtn = document.getElementById("bookmarks-import-btn");

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
      bookmarksPanel.classList.add("hidden");
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

exportBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  await window.celestial.exportBookmarks();
});

importBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const result = await window.celestial.importBookmarks();
  if (result.ok) renderBookmarks();
});

bookmarkBtn.addEventListener("click", () => {
  const isHidden = bookmarksPanel.classList.contains("hidden");
  if (isHidden) window.celestialClosePanels("bookmarks-panel");
  bookmarksPanel.classList.toggle("hidden");
  if (isHidden) renderBookmarks();
});

document.addEventListener("click", (e) => {
  if (!bookmarksPanel.classList.contains("hidden") && !bookmarksPanel.contains(e.target) && e.target !== bookmarkBtn) {
    bookmarksPanel.classList.add("hidden");
  }
});

window.celestial.onShortcut(async (action) => {
  if (action !== "bookmark-current") return;
  const wv = window.celestialActiveWebview();
  if (!wv || !wv.src) return;
  await window.celestial.addBookmark({ url: wv.src, title: wv.getTitle() || wv.src });
  if (!bookmarksPanel.classList.contains("hidden")) renderBookmarks();
});
