#!/usr/bin/env python3
"""Celestial BrowserEngine / Launcher - Hardened Chromium"""
import subprocess
import sys
import os
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    from custom_proxy import set_current_top_level
except ImportError:
    def set_current_top_level(h): pass

CHROMIUM_PRIVACY_FLAGS = [
    "--disable-sync", "--disable-translate", "--disable-background-networking",
    "--disable-default-apps", "--disable-extensions", "--disable-component-update",
    "--disable-breakpad", "--disable-crash-reporter", "--no-pings", "--no-referrers",
    "--disable-notifications", "--disable-geolocation",
    "--enable-strict-site-isolation", "--site-per-process",
    "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disk-cache-size=1", "--media-cache-size=1",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic", "--dns-prefetch-disable",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--no-sandbox", "--disable-dev-shm-usage",
]

def get_chrome_path():
    candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "google-chrome", "chromium"]
    for c in candidates:
        if os.path.exists(c) or subprocess.run(["which", c], capture_output=True).returncode == 0:
            return c
    return None

def launch_browser(target_url="https://example.com", proxy_port=8080):
    chrome = get_chrome_path()
    if not chrome:
        raise RuntimeError("Chrome/Chromium not found")

    parsed = urllib.parse.urlparse(target_url if "://" in target_url else f"https://{target_url}")
    hostname = parsed.hostname or target_url.split('/')[0]
    set_current_top_level(hostname)

    cmd = [chrome] + CHROMIUM_PRIVACY_FLAGS[:]
    if os.environ.get("CELESTIAL_HEADLESS") == "1":
        cmd.append("--headless=new")
    cmd.append(f"--proxy-server=http://127.0.0.1:{proxy_port}")
    cmd.append(f"--user-data-dir=/tmp/celestial_profile_{int(time.time())}")
    cmd.append(f"--app={target_url}")
    cmd.append(target_url)

    env = os.environ.copy()
    env["GOOGLE_API_KEY"] = "no"
    env["GOOGLE_DEFAULT_CLIENT_ID"] = "no"
    env["GOOGLE_DEFAULT_CLIENT_SECRET"] = "no"

    print(f"[LAUNCHER] Launching hardened Chromium for {target_url}")
    proc = subprocess.Popen(cmd, env=env)
    proc.wait()

if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "https://github.com"
    launch_browser(url)
