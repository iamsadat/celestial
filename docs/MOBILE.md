# Celestial Mobile Strategy

**Goal**: First-class privacy browser on iOS and Android without forking a browser engine.

## Recommended Path
Use system WebView + hardened local proxy layer via Capacitor.

- iOS: Capacitor + WKWebView + Network Extension
- Android: Capacitor + WebView + VpnService

The god-level dashboard becomes the main UI. Proxy runs as background service or pairs with WireGuard.

See mobile/capacitor/ for the starter project.
