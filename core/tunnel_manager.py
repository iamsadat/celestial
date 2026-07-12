#!/usr/bin/env python3
"""
Celestial / Vault - TunnelManager + Kill-Switch + Network Obfuscation
"""

import threading
import time
import socket
import random
import string
import urllib.request
from datetime import datetime, timezone
import json
from pathlib import Path

_tunnel_healthy = True
_tunnel_last_ok = time.time()
_tunnel_lock = threading.Lock()
_config = {}
_health_thread = None
_stop_health = False

def load_tunnel_config(config_path="desktop/config/vault_config.json"):
    global _config
    try:
        with open(config_path, 'r') as f:
            full = json.load(f)
        _config = full.get("network_obfuscation", {})
        if not _config:
            _config = {"enabled": False}
        print(f"[TUNNEL] Network Obfuscation loaded. Enabled={_config.get('enabled')}")
    except Exception as e:
        print(f"[TUNNEL][ERROR] {e}")
        _config = {"enabled": False}

def is_tunnel_healthy():
    with _tunnel_lock:
        return _tunnel_healthy

def set_tunnel_healthy(healthy: bool, reason=""):
    global _tunnel_healthy, _tunnel_last_ok
    with _tunnel_lock:
        old = _tunnel_healthy
        _tunnel_healthy = healthy
        if healthy:
            _tunnel_last_ok = time.time()
        if old != healthy:
            status = "SECURE" if healthy else "COMPROMISED - KILL SWITCH ACTIVATED"
            print(f"[TUNNEL][{status}] {reason}")

def get_padding_bytes():
    if not _config.get("enable_packet_padding", True):
        return b""
    min_b = _config.get("padding_min_bytes", 64)
    max_b = _config.get("padding_max_bytes", 512)
    length = random.randint(min_b, max_b)
    alphabet = string.ascii_letters + string.digits + string.punctuation
    padding = ''.join(random.choices(alphabet, k=length)).encode('utf-8', errors='ignore')
    return padding

def add_padding_to_request(headers: dict, body: bytes = b"") -> tuple:
    if not _config.get("enable_packet_padding", True):
        return headers, body
    pad = get_padding_bytes()
    if pad:
        headers["X-Vault-Padding"] = pad[:64].decode('utf-8', errors='ignore')
        if body:
            body = body + b"\r\n--vault-pad--" + pad
    return headers, body

def should_block_due_to_killswitch():
    if not _config.get("enabled") or not _config.get("kill_switch"):
        return False
    return not is_tunnel_healthy()

def get_security_status_message():
    if is_tunnel_healthy():
        return "🛡️ Celestial Secure Tunnel Active — All traffic obfuscated & padded"
    else:
        return "⛔ NETWORK NOT SECURE — VPN/Kill-Switch triggered. All requests frozen."

def setup_socks5_upstream():
    try:
        import socks
        if not _config.get("enabled") or _config.get("mode") != "socks5":
            return False
        host = _config.get("upstream_host", "127.0.0.1")
        port = _config.get("upstream_port", 1080)
        username = _config.get("username") or None
        password = _config.get("password") or None
        socks.set_default_proxy(socks.SOCKS5, host, port, username=username, password=password, rdns=True)
        socket.socket = socks.socksocket
        print(f"[TUNNEL] ✓ Real SOCKS5 chaining ACTIVE → {host}:{port}")
        return True
    except Exception as e:
        print(f"[TUNNEL][ERROR] Failed to setup SOCKS5: {e}")
        return False

def setup_upstream_if_needed():
    if _config.get("enabled") and _config.get("mode") == "socks5":
        return setup_socks5_upstream()
    return False
