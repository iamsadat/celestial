"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Minimal read-only bridge for the local new-tab start page ONLY -- main.js's
// will-attach-webview handler pins this preload strictly to the exact
// start.html file URL (never to real web content), so exposing these two
// read-only IPC calls here carries none of the risk it would on a real page.
contextBridge.exposeInMainWorld("celestialStart", {
  getStatus: () => ipcRenderer.invoke("celestial:status"),
  getBookmarks: () => ipcRenderer.invoke("celestial:bookmarks:list"),
});
