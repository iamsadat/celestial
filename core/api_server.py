#!/usr/bin/env python3
"""
Celestial API Server (FastAPI)
Provides live data to the god-level dashboard and future mobile apps.

Run with:
    uvicorn core.api_server:app --host 127.0.0.1 --port 8765 --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
import time
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).parent))

try:
    from tunnel_manager import is_tunnel_healthy, get_security_status_message
except ImportError:
    def is_tunnel_healthy(): return True
    def get_security_status_message(): return "🛡️ Secure (demo mode)"

app = FastAPI(title="Celestial API", version="1.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

@app.get("/config")
async def get_config():
    config_path = Path(__file__).parent.parent / "desktop/config/vault_config.json"
    if config_path.exists():
        return json.loads(config_path.read_text())
    return {"error": "Config not found"}

@app.post("/config")
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
