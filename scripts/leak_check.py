#!/usr/bin/env python3
"""
Human-runnable offline integration proof for the Celestial proxy.

Starts the real ProxyHandler on an ephemeral loopback port, backed by a real
local stub HTTP server standing in for "the internet" (resolve_host is
stubbed to the stub's own loopback IP -- no real DoH network call needed for
this offline check). Proves, against the real running proxy:

  (a) an allowed request is forwarded end-to-end and returns the stub's body.
  (b) with the tunnel forced unhealthy and strict_killswitch armed, every
      request is blocked with 503 and ZERO bytes ever reach the stub.

Run: python3 scripts/leak_check.py
"""
import http.client
import http.server
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "core"))

import custom_proxy as cp
import tunnel_manager as tm

STUB_BODY = b"celestial-leak-check-stub-response"
hit_count = 0
_hit_lock = threading.Lock()


class StubHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        global hit_count
        with _hit_lock:
            hit_count += 1
        self.send_response(200)
        self.send_header("Content-Length", str(len(STUB_BODY)))
        self.end_headers()
        self.wfile.write(STUB_BODY)

    def log_message(self, *a):
        pass


def _start_server(server_cls, handler_cls):
    server = server_cls(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _get_via_proxy(proxy_port, target_host, target_port, path="/hello"):
    conn = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=5)
    # Connection: close -- _kill_switch_block doesn't send Content-Length, so under HTTP/1.1
    # keep-alive the client can't frame the body; closing forces EOF-terminated reads to complete.
    conn.request("GET", f"http://{target_host}:{target_port}{path}",
                 headers={"Host": target_host, "Connection": "close"})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def main():
    failures = []

    stub = _start_server(http.server.HTTPServer, StubHandler)
    stub_port = stub.server_address[1]

    cp._allowed_hosts = {"allowed.test"}
    cp.resolve_host = lambda host: "127.0.0.1"  # stand-in for DoH: no real network resolution in this offline check
    tm._config = {"strict_killswitch": True, "enable_packet_padding": False}
    tm.set_tunnel_healthy(True, "leak_check init")

    proxy = _start_server(cp.ThreadedProxyServer, cp.ProxyHandler)
    proxy_port = proxy.server_address[1]
    time.sleep(0.1)  # let both accept loops come up

    # (a) allowed request routes through end-to-end
    status, body = _get_via_proxy(proxy_port, "allowed.test", stub_port)
    ok = status == 200 and body == STUB_BODY and hit_count == 1
    print(f"{'PASS' if ok else 'FAIL'}: allowed request routed through (status={status}, stub_hits={hit_count})")
    if not ok:
        failures.append("allowed request did not route through cleanly")

    # (b) strict kill-switch: tunnel unhealthy -> every request blocked, zero bytes reach stub
    tm.set_tunnel_healthy(False, "leak_check: simulate tunnel down")
    hits_before = hit_count
    blocked_all = True
    for _ in range(5):
        status, _ = _get_via_proxy(proxy_port, "allowed.test", stub_port)
        if status != 503:
            blocked_all = False
    leaked = hit_count - hits_before
    ok = blocked_all and leaked == 0
    print(f"{'PASS' if ok else 'FAIL'}: strict kill-switch blocked all requests, zero bytes reached stub (leaked={leaked})")
    if not ok:
        failures.append("kill-switch failed to block all traffic / bytes leaked to stub")

    if failures:
        print(f"\nFAIL: {len(failures)} check(s) failed")
        sys.exit(1)
    print("\nPASS: all leak checks passed")
    sys.exit(0)


if __name__ == "__main__":
    main()
