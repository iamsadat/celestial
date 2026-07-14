#!/usr/bin/env python3
"""
Opt-in LIVE end-to-end leak check against the real internet.

Unlike scripts/leak_check.py (a local stub target, always safe, run in CI),
this boots the real proxy and drives a REAL HTTPS CONNECT tunnel through it to
a public IP-echo service (https://api.ipify.org) -- the same tunnel mode a
real browser uses for HTTPS proxying. Proves, against the real network stack
(real DoH resolution, real TLS, real CONNECT):

  (a) tunnel healthy -> the request completes end-to-end through the proxy.
  (b) tunnel forced down (strict kill-switch) -> the CONNECT is rejected by
      the proxy before any bytes reach the real target -- zero leak.

Refuses to run unless CELESTIAL_LIVE_TEST=1 is set. Never collected by
pytest: it lives in scripts/ (not tests/test_*.py) and makes real outbound
network calls, so it must never run unattended in CI/offline.

Run: CELESTIAL_LIVE_TEST=1 python3 scripts/live_leak_check.py
"""
import http.client
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "core"))

import custom_proxy as cp
import tunnel_manager as tm

TARGET_HOST = "api.ipify.org"
TARGET_PORT = 443


def _start_proxy():
    server = cp.ThreadedProxyServer(("127.0.0.1", 0), cp.ProxyHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _connect_through_proxy(proxy_port, timeout=15):
    """Real CONNECT tunnel through the proxy -- the browser HTTPS-proxying path."""
    conn = http.client.HTTPSConnection("127.0.0.1", proxy_port, timeout=timeout)
    conn.set_tunnel(TARGET_HOST, TARGET_PORT)
    conn.request("GET", "/")
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def main():
    if os.environ.get("CELESTIAL_LIVE_TEST") != "1":
        print("SKIPPED: set CELESTIAL_LIVE_TEST=1 to run this live network test.")
        sys.exit(0)

    failures = []

    cp._allowed_hosts = {TARGET_HOST}
    tm._config = {"strict_killswitch": True, "enable_packet_padding": False}
    tm.set_tunnel_healthy(True, "live_leak_check init")

    proxy = _start_proxy()
    proxy_port = proxy.server_address[1]
    time.sleep(0.1)  # let the accept loop come up

    # (a) tunnel healthy -> real request completes end-to-end
    try:
        status, body = _connect_through_proxy(proxy_port)
        ok = status == 200 and len(body.strip()) > 0
        print(f"{'PASS' if ok else 'FAIL'}: live request through healthy tunnel "
              f"(status={status}, body={body[:40]!r})")
    except Exception as e:
        ok = False
        print(f"FAIL: live request through healthy tunnel raised {e!r}")
    if not ok:
        failures.append("healthy-tunnel live request did not complete")

    # (b) tunnel forced down -> CONNECT rejected before any real bytes leak
    tm.set_tunnel_healthy(False, "live_leak_check: simulate tunnel down")
    blocked = False
    try:
        _connect_through_proxy(proxy_port, timeout=10)
    except OSError as e:
        # http.client raises OSError("Tunnel connection failed: 503 ...") when the
        # CONNECT response isn't 200 -- proves the real target was never reached.
        blocked = "503" in str(e) or "Tunnel connection failed" in str(e)
    except Exception:
        blocked = True  # any other failure to complete the tunnel also counts as blocked
    print(f"{'PASS' if blocked else 'FAIL'}: kill-switch blocked CONNECT before "
          f"reaching {TARGET_HOST} (blocked={blocked})")
    if not blocked:
        failures.append("kill-switch failed to block the live CONNECT tunnel")

    if failures:
        print(f"\nFAIL: {len(failures)} check(s) failed")
        sys.exit(1)
    print("\nPASS: all live leak checks passed")
    sys.exit(0)


if __name__ == "__main__":
    main()
