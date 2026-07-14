"use strict";
// Find-in-page, zoom, and print for the active webview -- three small,
// closely related "act on the focused webview" behaviors bundled here so
// renderer.js (which owns tab/window state) doesn't have to grow for them.
// Loaded before renderer.js in index.html so window.celestialWireFindEvents
// exists by the time renderer.js's startup tab restore calls it.

const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const findPrevBtn = document.getElementById("find-prev-btn");
const findNextBtn = document.getElementById("find-next-btn");
const findCloseBtn = document.getElementById("find-close-btn");
const zoomIndicator = document.getElementById("zoom-indicator");

let zoomIndicatorTimer = null;

function activeWebview() {
  return window.celestialActiveWebview();
}

function showZoomIndicator(level) {
  const pct = Math.round(100 * Math.pow(1.2, level)); // Chromium's zoom-level -> factor formula
  zoomIndicator.textContent = `${pct}%`;
  zoomIndicator.classList.remove("hidden");
  clearTimeout(zoomIndicatorTimer);
  zoomIndicatorTimer = setTimeout(() => zoomIndicator.classList.add("hidden"), 1200);
}

function zoom(action) {
  const wv = activeWebview();
  if (!wv) return;
  const current = wv.getZoomLevel();
  const next = action === "reset" ? 0 : action === "in" ? Math.min(current + 1, 9) : Math.max(current - 1, -9);
  wv.setZoomLevel(next);
  showZoomIndicator(next);
}

function openFindBar() {
  const wv = activeWebview();
  if (!wv) return;
  findBar.classList.remove("hidden");
  findInput.focus();
  findInput.select();
  if (findInput.value) wv.findInPage(findInput.value);
}

function closeFindBar() {
  activeWebview()?.stopFindInPage("clearSelection");
  findBar.classList.add("hidden");
  findCount.textContent = "";
}

findInput.addEventListener("input", () => {
  const wv = activeWebview();
  if (!wv) return;
  if (!findInput.value) {
    wv.stopFindInPage("clearSelection");
    findCount.textContent = "";
    return;
  }
  wv.findInPage(findInput.value);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeFindBar();
  } else if (e.key === "Enter") {
    const wv = activeWebview();
    if (wv && findInput.value) wv.findInPage(findInput.value, { forward: !e.shiftKey, findNext: true });
  }
});
findPrevBtn.addEventListener("click", () => {
  const wv = activeWebview();
  if (wv && findInput.value) wv.findInPage(findInput.value, { forward: false, findNext: true });
});
findNextBtn.addEventListener("click", () => {
  const wv = activeWebview();
  if (wv && findInput.value) wv.findInPage(findInput.value, { forward: true, findNext: true });
});
findCloseBtn.addEventListener("click", closeFindBar);

// found-in-page fires on the webview's own webContents, so it has to be
// wired per-tab like the other webview listeners in renderer.js's
// wireWebviewEvents -- exposed here so renderer.js can call it at
// materialize time without this file needing to know about tab internals.
window.celestialWireFindEvents = (webview) => {
  webview.addEventListener("found-in-page", (e) => {
    const { activeMatchOrdinal, matches } = e.result;
    findCount.textContent = matches ? `${activeMatchOrdinal}/${matches}` : "0/0";
  });
};

window.celestial.onShortcut((action) => {
  switch (action) {
    case "find": openFindBar(); break;
    case "zoom-in": zoom("in"); break;
    case "zoom-out": zoom("out"); break;
    case "zoom-reset": zoom("reset"); break;
    case "print": activeWebview()?.print(); break;
  }
});
