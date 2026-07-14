"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// Same path main.js computes for its will-attach-webview guard (START_PAGE_URL) --
// both files live directly under app/, so this resolves to the identical string.
const START_PAGE_URL = pathToFileURL(path.join(__dirname, "renderer", "start.html")).toString();

// Minimal bridge: tab navigation is handled by the renderer talking directly
// to its own <webview> DOM elements (same-process DOM call, no IPC needed).
// The one thing that genuinely crosses a process boundary is sidecar status.
contextBridge.exposeInMainWorld("celestial", {
  startPageUrl: START_PAGE_URL,
  getStatus: () => ipcRenderer.invoke("celestial:status"),
  setTopLevel: (host) => ipcRenderer.invoke("celestial:set-top-level", host),
  getBookmarks: () => ipcRenderer.invoke("celestial:bookmarks:list"),
  addBookmark: (bookmark) => ipcRenderer.invoke("celestial:bookmarks:add", bookmark),
  deleteBookmark: (id) => ipcRenderer.invoke("celestial:bookmarks:delete", id),
  getTabs: () => ipcRenderer.invoke("celestial:tabs:get"),
  saveTabs: (tabs) => ipcRenderer.invoke("celestial:tabs:save", tabs),
  getConfig: () => ipcRenderer.invoke("celestial:config:get"),
  setConfig: (config) => ipcRenderer.invoke("celestial:config:set", config),
  listHistory: () => ipcRenderer.invoke("celestial:history:list"),
  addHistory: (entry) => ipcRenderer.invoke("celestial:history:add", entry),
  clearHistory: () => ipcRenderer.invoke("celestial:history:clear"),
  deleteHistoryEntry: (id) => ipcRenderer.invoke("celestial:history:delete", id),
  listDownloads: () => ipcRenderer.invoke("celestial:downloads:list"),
  showDownload: (filePath) => ipcRenderer.invoke("celestial:downloads:show", filePath),
  onDownloadEvent: (cb) => ipcRenderer.on("celestial:downloads:event", (_e, payload) => cb(payload)),
});
