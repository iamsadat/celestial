"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Minimal bridge: tab navigation is handled by the renderer talking directly
// to its own <webview> DOM elements (same-process DOM call, no IPC needed).
// The one thing that genuinely crosses a process boundary is sidecar status.
contextBridge.exposeInMainWorld("celestial", {
  getStatus: () => ipcRenderer.invoke("celestial:status"),
  setTopLevel: (host) => ipcRenderer.invoke("celestial:set-top-level", host),
});
