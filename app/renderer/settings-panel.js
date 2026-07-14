"use strict";
// Settings panel: proxy/tunnel status, kill-switch toggles, tracker whitelist,
// and upstream (SOCKS5) tunnel form. Talks only to celestial.getConfig/setConfig,
// which proxy GET/POST /config through main -- this file never sees the API token.

const menuBtn = document.getElementById("menu-btn");
const panel = document.getElementById("settings-panel");
const statusEl = document.getElementById("settings-status");
const killSwitchToggle = document.getElementById("killswitch-toggle");
const strictToggle = document.getElementById("strict-killswitch-toggle");
const whitelistList = document.getElementById("whitelist-list");
const whitelistInput = document.getElementById("whitelist-input");
const whitelistAddBtn = document.getElementById("whitelist-add-btn");
const tunnelEnabled = document.getElementById("tunnel-enabled-toggle");
const tunnelHost = document.getElementById("tunnel-host");
const tunnelPort = document.getElementById("tunnel-port");
const tunnelUsername = document.getElementById("tunnel-username");
const tunnelPassword = document.getElementById("tunnel-password");
const saveBtn = document.getElementById("settings-save-btn");
const saveMsg = document.getElementById("settings-save-msg");

let currentConfig = null;

// GET /config (core/api_server.py) returns whatever's on disk, including an
// {"error": ...} shape if desktop/config/vault_config.json doesn't exist yet.
// Normalize to the fields this panel edits, preserving any unknown keys.
function normalizeConfig(raw) {
  const cfg = raw && !raw.error && typeof raw === "object" ? raw : {};
  return {
    ...cfg,
    whitelist: Array.isArray(cfg.whitelist) ? cfg.whitelist.slice() : [],
    network_obfuscation: {
      enabled: false,
      kill_switch: false,
      strict_killswitch: false,
      mode: "socks5",
      upstream_host: "",
      upstream_port: 1080,
      username: "",
      password: "",
      ...(cfg.network_obfuscation || {}),
    },
  };
}

function renderWhitelist() {
  whitelistList.innerHTML = "";
  if (!currentConfig.whitelist.length) {
    const empty = document.createElement("div");
    empty.className = "whitelist-empty";
    empty.textContent = "No allowed hosts";
    whitelistList.appendChild(empty);
    return;
  }
  for (const host of currentConfig.whitelist) {
    const row = document.createElement("div");
    row.className = "whitelist-row";
    const label = document.createElement("span");
    label.className = "whitelist-host mono";
    label.textContent = host;
    const remove = document.createElement("span");
    remove.className = "whitelist-remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      currentConfig.whitelist = currentConfig.whitelist.filter((h) => h !== host);
      renderWhitelist();
    });
    row.appendChild(label);
    row.appendChild(remove);
    whitelistList.appendChild(row);
  }
}

whitelistAddBtn.addEventListener("click", () => {
  const host = whitelistInput.value.trim();
  if (!host || currentConfig.whitelist.includes(host)) return;
  currentConfig.whitelist.push(host);
  whitelistInput.value = "";
  renderWhitelist();
});

function populateForm() {
  const n = currentConfig.network_obfuscation;
  killSwitchToggle.checked = !!n.kill_switch;
  strictToggle.checked = !!n.strict_killswitch;
  tunnelEnabled.checked = !!n.enabled;
  tunnelHost.value = n.upstream_host || "";
  tunnelPort.value = n.upstream_port || "";
  tunnelUsername.value = n.username || "";
  tunnelPassword.value = ""; // write-only: never show the stored password
  renderWhitelist();
}

async function loadSettings() {
  saveMsg.textContent = "";
  try {
    const status = await window.celestial.getStatus();
    statusEl.textContent = status.tunnel_healthy
      ? "Secure -- tunnel healthy"
      : (status.status_message || "Offline -- tunnel down");
    statusEl.classList.toggle("secure", !!status.tunnel_healthy);
    statusEl.classList.toggle("offline", !status.tunnel_healthy);
  } catch {
    statusEl.textContent = "Status unavailable";
  }
  currentConfig = normalizeConfig(await window.celestial.getConfig());
  populateForm();
}

saveBtn.addEventListener("click", async () => {
  const n = currentConfig.network_obfuscation;
  n.kill_switch = killSwitchToggle.checked;
  n.strict_killswitch = strictToggle.checked;
  n.enabled = tunnelEnabled.checked;
  n.mode = "socks5";
  n.upstream_host = tunnelHost.value.trim();
  n.upstream_port = Number(tunnelPort.value) || 0;
  n.username = tunnelUsername.value.trim();
  if (tunnelPassword.value) n.password = tunnelPassword.value; // untouched -> keeps stored value

  saveMsg.textContent = "Saving...";
  try {
    const result = await window.celestial.setConfig(currentConfig);
    saveMsg.textContent = result && result.error ? `Error: ${result.error}` : "Saved";
    tunnelPassword.value = "";
  } catch {
    saveMsg.textContent = "Save failed";
  }
});

menuBtn.addEventListener("click", () => {
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) window.celestialClosePanels("settings-panel");
  panel.classList.toggle("hidden");
  if (isHidden) loadSettings();
});

document.addEventListener("click", (e) => {
  if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target !== menuBtn) {
    panel.classList.add("hidden");
  }
});
