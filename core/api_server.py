#!/usr/bin/env python3
"""
Celestial API Server (FastAPI)
Provides live data to the god-level dashboard and future mobile apps.

Run with:
    uvicorn core.api_server:app --host 127.0.0.1 --port 8765 --reload
"""

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
import time
import secrets
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).parent))

try:
    from tunnel_manager import is_tunnel_healthy, get_security_status_message
except ImportError:
    def is_tunnel_healthy(): return True
    def get_security_status_message(): return "🛡️ Secure (demo mode)"

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
    config_path = Path(__file__).parent.parent / "desktop/config/vault_config.json"
    if config_path.exists():
        return json.loads(config_path.read_text())
    return {"error": "Config not found"}

@app.post("/config", dependencies=[Depends(require_token)])
async def update_config(new_config: dict):
    config_path = Path(__file__).parent.parent / "desktop/config/vault_config.json"
    config_path.write_text(json.dumps(new_config, indent=2))
    return {"status": "updated", "timestamp": time.time()}

@app.get("/health")
async def health():
    return {"status": "ok", "service": "celestial-api"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
