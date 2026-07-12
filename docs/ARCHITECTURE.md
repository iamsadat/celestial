# Celestial Architecture

## Philosophy
Celestial is a **thin-client privacy platform**. The Python proxy + tunnel layer is the source of truth for security. The rendering engine is untrusted and heavily constrained.

## Layers

1. UI Layer (Desktop Dashboard / Mobile Capacitor / Future Tauri)
2. API Layer (FastAPI)
3. Tunnel Manager (Kill-Switch + SOCKS5 + Padding + DoH)
4. Custom Proxy (Filtering + Audit + Tracker Blocking)
5. Rendering Engines (Hardened Chromium / System WebView)

## Security Boundaries
- No raw sockets from the browser
- No system DNS (DoH enforced)
- Kill-switch guarantees zero leak on failure
- Full audit of every decision
