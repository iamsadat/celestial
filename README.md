# Celestial - Zero-Leakage Privacy Browser

**Zero Data Leakage by Design**

A hardened, privacy-centric browser platform built from the ground up so that zero bytes of user data leave the device except to the exact origin the user requested.

## Features

- Strict network isolation with custom Python proxy
- Real SOCKS5 / WireGuard chaining
- Instant Kill-Switch (freezes all traffic if tunnel drops)
- DPI-resistant packet padding
- Protected DoH resolver
- Built-in tracker / ad blocking
- God-level Control Center dashboard (glassmorphism, live API, mobile bottom nav, PWA)
- Capacitor mobile starter for iOS & Android
- Full architecture + progress docs

## Quick Start

```bash
# 1. Start the live API (reads CELESTIAL_API_HOST / CELESTIAL_API_PORT, default 127.0.0.1:8765)
uvicorn core.api_server:app --host 127.0.0.1 --port 8765 --reload

# 2. Start the privacy proxy
python core/custom_proxy.py

# 3. Launch the hardened browser through it
python core/browser_launcher.py https://github.com

# 4. Open the dashboard
open desktop/celestial-dashboard.html
# or
python -m http.server 8081 --directory desktop
```

> The dashboard loads Tailwind via the CDN JIT compiler (`cdn.tailwindcss.com`) for
> convenience in dev. For production, prebuild a static Tailwind stylesheet instead
> of shipping the runtime compiler.

## Deploy

```bash
# Docker (production, no --reload)
docker build -t celestial .
docker run -p 8765:8765 -e CELESTIAL_API_HOST=0.0.0.0 celestial

# systemd
sudo cp deploy/celestial.service /etc/systemd/system/
sudo systemctl enable --now celestial
```

## Project Structure

```
celestial/
├── core/                 # Privacy engine (proxy, tunnel, DoH, API)
├── desktop/              # God-level dashboard + PWA assets
├── mobile/               # Capacitor iOS/Android starter
├── docs/                 # Architecture, Progress, Mobile strategy
├── setup.sh              # One-command local setup
└── README.md
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Progress Tracker](docs/PROGRESS.md)
- [Mobile Strategy](docs/MOBILE.md)

## License

MIT (or as preferred)

Built with multi-agent workflows + god-level UI principles.
