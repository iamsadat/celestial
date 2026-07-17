"use strict";
// History panel: full list from celestial.listHistory, filtered client-side
// (small enough at the 5000-entry cap that a server-side search isn't needed).

const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");
const searchInput = document.getElementById("history-search");
const clearBtn = document.getElementById("history-clear-btn");

let allEntries = [];

function relTime(ts) {
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function renderList() {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = q
    ? allEntries.filter((h) => h.url.toLowerCase().includes(q) || (h.title || "").toLowerCase().includes(q))
    : allEntries;

  historyListEl.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = q ? "No matches" : "No history yet";
    historyListEl.appendChild(empty);
    return;
  }
  for (const h of filtered) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.title = h.url;

    const info = document.createElement("div");
    info.className = "history-info";
    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = h.title || h.url;
    const url = document.createElement("div");
    url.className = "history-url mono";
    url.textContent = h.url;
    info.appendChild(title);
    info.appendChild(url);
    info.addEventListener("click", () => {
      const wv = window.celestialActiveWebview();
      if (wv) window.celestialGoTo(wv, h.url);
      historyPanel.classList.add("hidden");
    });

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = relTime(h.visitedAt);

    const remove = document.createElement("span");
    remove.className = "history-remove";
    remove.textContent = "×";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.celestial.deleteHistoryEntry(h.id);
      allEntries = allEntries.filter((entry) => entry.id !== h.id);
      renderList();
    });

    row.appendChild(info);
    row.appendChild(time);
    row.appendChild(remove);
    historyListEl.appendChild(row);
  }
}

async function loadHistory() {
  allEntries = await window.celestial.listHistory();
  renderList();
}

searchInput.addEventListener("input", renderList);

clearBtn.addEventListener("click", async () => {
  await window.celestial.clearHistory();
  allEntries = [];
  renderList();
});

historyBtn.addEventListener("click", () => {
  const isHidden = historyPanel.classList.contains("hidden");
  if (isHidden) window.celestialClosePanels("history-panel");
  historyPanel.classList.toggle("hidden");
  if (isHidden) loadHistory();
});

document.addEventListener("click", (e) => {
  if (!historyPanel.classList.contains("hidden") && !historyPanel.contains(e.target) && e.target !== historyBtn) {
    historyPanel.classList.add("hidden");
  }
});

window.celestial.onShortcut((action) => {
  if (action === "history-panel") historyBtn.click();
});
