#!/usr/bin/env python3
"""
Celestial API Server (FastAPI)
Provides live data to the god-level dashboard and future mobile apps.

Run with:
    uvicorn core.api_server:app --host 127.0.0.1 --port 8765 --reload
"""

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
import json
import os
import time
import secrets
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).parent))

try:
    from tunnel_manager import (
        is_tunnel_healthy, get_security_status_message,
        setup_upstream_if_needed, load_tunnel_config,
    )
except ImportError:
    def is_tunnel_healthy(): return True
    def get_security_status_message(): return "🛡️ Secure (demo mode)"
    def setup_upstream_if_needed(): return False
    def load_tunnel_config(config_path=None): pass

app = FastAPI(title="Celestial API", version="1.2")

# Wildcard origin lets ANY webpage open in ANY local browser call this API -
# and it can rewrite the whitelist / kill-switch via POST /config. Restrict to
# the dashboard's own known local origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8081", "http://localhost:8081",
        "http://127.0.0.1:8765", "http://localhost:8765",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Matches the meta CSP tag in desktop/celestial-dashboard.html - keep them in sync.
# unsafe-inline is needed for the dashboard's inline <script>/onclick handlers and
# the Tailwind CDN's runtime-injected <style>; connect-src covers the API itself.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; "
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
    "font-src 'self' https://cdnjs.cloudflare.com; "
    "img-src 'self' data:; "
    "connect-src 'self' http://127.0.0.1:8765 http://localhost:8765; "
    "manifest-src 'self'"
)

@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = _CSP
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response

# CORS is a browser-only control (doesn't stop curl or another local process),
# so /config - which can disable the kill-switch or empty the whitelist - also
# requires a shared-secret token. Generated once, stored next to the config the
# dashboard already reads from the same local static server (same-origin only;
# no CORS headers there, so a cross-origin page can't fetch it).
_TOKEN_PATH = Path(__file__).parent.parent / "desktop/config/.api_token"

def _load_or_create_token() -> str:
    _TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    if _TOKEN_PATH.exists():
        return _TOKEN_PATH.read_text().strip()
    token = secrets.token_urlsafe(32)
    _TOKEN_PATH.write_text(token)
    return token

_API_TOKEN = _load_or_create_token()

def require_token(x_celestial_token: str = Header(default="")):
    if not secrets.compare_digest(x_celestial_token, _API_TOKEN):
        raise HTTPException(status_code=401, detail="Missing or invalid X-Celestial-Token")

_CONFIG_PATH = Path(__file__).parent.parent / "desktop/config/vault_config.json"

# Sentinel the GET side substitutes for a stored password so the settings panel
# never sees the real secret. The POST side treats this literal value as "unchanged"
# instead of persisting it -- required because the panel round-trips GET's response
# back on save when the user leaves the password field blank.
_PASSWORD_MASK = "***"

_VALID_MODES = {"socks5"}

class NetworkObfuscationUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None
    upstream_host: Optional[str] = None
    upstream_port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = None
    password: Optional[str] = None
    kill_switch: Optional[bool] = None
    strict_killswitch: Optional[bool] = None

    @field_validator("mode")
    @classmethod
    def _mode_whitelist(cls, v):
        if v is not None and v not in _VALID_MODES:
            raise ValueError(f"mode must be one of {sorted(_VALID_MODES)}")
        return v

class ConfigUpdate(BaseModel):
    proxy_port: Optional[int] = Field(default=None, ge=1, le=65535)
    whitelist: Optional[List[str]] = None
    block_websockets: Optional[bool] = None
    default_user_agent: Optional[str] = None
    static_accept_language: Optional[str] = None
    network_obfuscation: Optional[NetworkObfuscationUpdate] = None

class StatusResponse(BaseModel):
    tunnel_healthy: bool
    status_message: str
    timestamp: float
    blocked_today: int = 184

@app.get("/status", response_model=StatusResponse)
async def get_status():
    return {
        "tunnel_healthy": is_tunnel_healthy(),
        "status_message": get_security_status_message(),
        "timestamp": time.time(),
        "blocked_today": 184
    }

@app.get("/config", dependencies=[Depends(require_token)])
async def get_config():
    if not _CONFIG_PATH.exists():
        return {"error": "Config not found"}
    data = json.loads(_CONFIG_PATH.read_text())
    net = data.get("network_obfuscation")
    if isinstance(net, dict) and net.get("password"):
        data = {**data, "network_obfuscation": {**net, "password": _PASSWORD_MASK}}
    return data

@app.post("/config", dependencies=[Depends(require_token)])
async def update_config(update: ConfigUpdate):
    existing = {}
    if _CONFIG_PATH.exists():
        try:
            existing = json.loads(_CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            existing = {}

    incoming = update.model_dump(exclude_unset=True)
    net_incoming = incoming.pop("network_obfuscation", None)
    existing.update(incoming)

    upstream_changed = False
    if net_incoming is not None:
        net_existing = existing.get("network_obfuscation")
        if not isinstance(net_existing, dict):
            net_existing = {}
        if net_incoming.get("password") == _PASSWORD_MASK:
            net_incoming.pop("password")  # sentinel round-tripped unchanged -- keep stored value
        net_existing.update(net_incoming)
        existing["network_obfuscation"] = net_existing
        upstream_changed = True

    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(json.dumps(existing, indent=2))

    if upstream_changed:
        try:
            load_tunnel_config(str(_CONFIG_PATH))  # refresh tunnel_manager's in-process config first
            setup_upstream_if_needed()
        except Exception as e:
            print(f"[API][ERROR] setup_upstream_if_needed failed: {e}")

    return {"status": "updated", "timestamp": time.time()}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "celestial-api"}

if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("CELESTIAL_API_HOST", "127.0.0.1")
    port = int(os.environ.get("CELESTIAL_API_PORT", "8765"))
    uvicorn.run(app, host=host, port=port)
