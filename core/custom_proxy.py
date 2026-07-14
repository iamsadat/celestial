#!/usr/bin/env python3
"""
Celestial Custom ProxyHandler
Strict network isolation, header sanitization, URL cleansing, whitelist,
tracker blocking, kill-switch, packet padding, and audit logging.
"""

import http.server
import http.client
import socketserver
import socket
import ssl
import urllib.parse
import json
import os
import secrets
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

# Import tunnel features
try:
    from tunnel_manager import (
        load_tunnel_config, is_tunnel_healthy, should_block_due_to_killswitch,
        get_security_status_message, add_padding_to_request, setup_upstream_if_needed,
        is_socks_upstream_active
    )
except ImportError:
    def load_tunnel_config(p=None): pass
    def is_tunnel_healthy(): return True
    def should_block_due_to_killswitch(): return False
    def get_security_status_message(): return "Secure"
    def add_padding_to_request(h, b=b""): return h, b
    def setup_upstream_if_needed(): return False
    def is_socks_upstream_active(): return False

try:
    from doh_resolver import resolve_host
except ImportError:
    def resolve_host(hostname): return None

# Hop-by-hop headers must never be forwarded (RFC 7230 6.1) plus proxy-specific ones.
_HOP_BY_HOP = {'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
               'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
               'host', 'content-length'}

# _allowed_hosts: static config whitelist (desktop/config/vault_config.json), never
# mutated by tab navigation.
#
# _active_top_levels: the Electron shell is a multi-tab process with one shared proxy
# sidecar, so a single "current top-level host" string misfired third-party checks
# across tabs (tab B's requests were judged against tab A's origin). Fixed by tracking
# the SET of currently-open tabs' top-level hosts instead, via the same token-gated
# control channel (set-top-level now also supports removal on tab close/navigate-away).
# ponytail: this still doesn't scope "is this a first-party request" to *which* tab
# asked -- any active tab's origin is fair game as an allowed top-level for any other
# tab's subresource check (true per-tab isolation needs a request-scoped tab id
# threaded through the control channel, real plumbing for a later phase). What this
# does fix: entries no longer accumulate forever -- bounded (LRU-evicted past
# _MAX_ACTIVE_TOP_LEVELS) and removable, so a closed tab's origin actually stops being
# trusted instead of leaking privilege for the rest of the process lifetime.
_MAX_ACTIVE_TOP_LEVELS = 50
_active_top_levels = OrderedDict()  # host -> None, ordered oldest-touched -> newest
_allowed_hosts = set()
_config = {}
_blocked_count = 0
_lock = threading.Lock()

# ponytail: set_current_top_level() only mutates *this process's* globals. That was
# fine when a launcher imported custom_proxy in-process (core/browser_launcher.py's
# old model), but the Electron shell runs this proxy as an independent sidecar
# process, so it needs a real (token-gated) way to call in across the process
# boundary. Shared secret reuses api_server.py's token file rather than minting a
# second one.
_CONTROL_TOKEN_PATH = Path(__file__).parent.parent / "desktop/config/.api_token"
_CONTROL_PATH = "/__celestial/set-top-level"

def _load_control_token():
    try:
        return _CONTROL_TOKEN_PATH.read_text().strip()
    except Exception:
        return None

def load_config(config_path="desktop/config/vault_config.json"):
    global _config, _allowed_hosts
    try:
        with open(config_path, 'r') as f:
            _config = json.load(f)
        _allowed_hosts = set(_config.get("whitelist", []))
        print(f"[PROXY] Loaded config. Whitelist: {_allowed_hosts or 'EMPTY (strict mode)'}")
        load_tunnel_config(config_path)
        setup_upstream_if_needed()
    except Exception as e:
        print(f"[PROXY][ERROR] {e}")
        _config = {"proxy_port": 8080, "whitelist": [], "block_websockets": True}
        _allowed_hosts = set()

def set_current_top_level(hostname):
    """Register a tab's top-level host as active (bounded LRU set)."""
    if not hostname:
        return
    h = hostname.lower().strip()
    with _lock:
        if h in _active_top_levels:
            _active_top_levels.move_to_end(h)
        else:
            _active_top_levels[h] = None
            if len(_active_top_levels) > _MAX_ACTIVE_TOP_LEVELS:
                _active_top_levels.popitem(last=False)
        print(f"[PROXY] Top-level origin active: {h} (active_count={len(_active_top_levels)})")

def clear_current_top_level(hostname):
    """Remove a top-level host from the active set (tab closed/navigated away)."""
    if not hostname:
        return
    h = hostname.lower().strip()
    with _lock:
        _active_top_levels.pop(h, None)
        print(f"[PROXY] Top-level origin cleared: {h} (active_count={len(_active_top_levels)})")

def is_request_allowed(hostname):
    if not hostname:
        return False
    h = hostname.lower().strip()

    # Built-in tracker / ad blocking
    tracker_domains = {
        "google-analytics.com", "googletagmanager.com", "doubleclick.net",
        "facebook.com", "fbcdn.net", "analytics.twitter.com",
        "scorecardresearch.com", "quantserve.com", "adnxs.com",
        "criteo.com", "taboola.com", "outbrain.com", "amazon-adsystem.com"
    }
    if any(h == d or h.endswith("." + d) for d in tracker_domains):
        audit_log("BLOCK_TRACKER", f"Tracker/ad domain blocked: {h}")
        return False

    with _lock:
        if h in _allowed_hosts:
            return True
        return h in _active_top_levels

def audit_log(category, details, blocked=True):
    global _blocked_count
    ts = datetime.now(timezone.utc).isoformat()
    if blocked:
        with _lock:
            _blocked_count += 1
        msg = f"[AUDIT][{category}][BLOCKED #{_blocked_count}] {ts} | {details}"
    else:
        msg = f"[AUDIT][{category}][ALLOWED] {ts} | {details}"
    print(msg)

def clean_url(url):
    try:
        parsed = urllib.parse.urlparse(url)
        if not parsed.query:
            return url
        qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        tracking_params = {'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'}
        cleaned_qs = {k: v for k, v in qs.items() if k.lower() not in tracking_params}
        new_query = urllib.parse.urlencode(cleaned_qs, doseq=True)
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_query, parsed.fragment))
    except Exception:
        return url

def sanitize_headers(headers):
    new_headers = {}
    for key, value in headers.items():
        k_lower = key.lower()
        if k_lower in ('referer', 'dnt', 'x-forwarded-for', 'via', 'forwarded'):
            continue
        elif k_lower == 'user-agent':
            new_headers[key] = _config.get("default_user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        elif k_lower == 'accept-language':
            new_headers[key] = _config.get("static_accept_language", "en-US,en;q=0.9")
        else:
            new_headers[key] = value
    return new_headers

def _dns_connect(host, port, timeout=15):
    """Connect a raw socket without leaking DNS to the OS resolver.
    SOCKS upstream active -> connect by hostname (remote/rdns resolution through the tunnel).
    Otherwise -> resolve via DoH and connect by IP. Fails closed (raises) if DoH resolution fails."""
    if is_socks_upstream_active():
        # ponytail: socket.create_connection() runs its own getaddrinfo(host) before
        # ever calling connect() -- a real local DNS leak (and a hard failure on hosts
        # that don't resolve locally, e.g. .onion/rdns-only names), even though
        # socket.socket is patched to socks.socksocket. Build+connect the socket
        # directly so PySocks (rdns=True) gets the raw hostname and resolves it
        # remotely, through the tunnel.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))
        return sock
    ip = resolve_host(host)
    if not ip:
        raise RuntimeError(f"DoH resolution failed for {host}")
    return socket.create_connection((ip, port), timeout=timeout)

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _get_host_from_request(self):
        host = self.headers.get('Host', '')
        if not host and hasattr(self, 'path') and self.command == 'CONNECT':
            host = self.path.split(':')[0]
        if not host:
            parsed = urllib.parse.urlparse(self.path)
            host = parsed.netloc or parsed.hostname or ''
        return host.split(':')[0] if host else ''

    def _block_request(self, reason, category="Network"):
        audit_log(category, f"{reason} | Method={self.command} Path={self.path}")
        self.send_error(403, f"Blocked by Celestial Proxy: {reason}")

    def _kill_switch_block(self):
        msg = get_security_status_message()
        audit_log("KILL_SWITCH", f"Tunnel down - all traffic frozen | {self.command} {self.path}")
        html = f"""<!DOCTYPE html><html><body style="font-family:system-ui;background:#0a0a0a;color:#ff4444;padding:40px;text-align:center">
        <h1>⛔ NETWORK NOT SECURE</h1>
        <p><strong>{msg}</strong></p>
        <p>All network requests have been frozen by the Vault Kill-Switch.</p>
        </body></html>""".encode('utf-8')
        self.send_response(503, "Network Not Secure")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))  # HTTP/1.1 keep-alive client hangs without framing
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(html)

    def do_CONNECT(self):
        if should_block_due_to_killswitch():
            self._kill_switch_block()
            return
        host = self.path.split(':')[0]
        if not is_request_allowed(host):
            self._block_request(f"HTTPS destination '{host}' not allowed")
            return
        try:
            port = int(self.path.split(':')[1]) if ':' in self.path else 443
            with _dns_connect(host, port, timeout=10) as target_sock:
                self.send_response(200, "Connection Established")
                self.end_headers()
                # Simple bidirectional tunnel
                def tunnel(src, dst):
                    try:
                        while True:
                            data = src.recv(65536)  # ponytail: was 4096, 16x fewer syscalls on bulk transfer
                            if not data: break
                            dst.sendall(data)
                    except: pass
                t1 = threading.Thread(target=tunnel, args=(self.connection, target_sock), daemon=True)
                t2 = threading.Thread(target=tunnel, args=(target_sock, self.connection), daemon=True)
                t1.start(); t2.start(); t1.join(); t2.join()
                audit_log("Network", f"HTTPS tunnel to {host}:{port}", blocked=False)
        except Exception as e:
            audit_log("Network", f"CONNECT failed to {host}: {e}")
            self.send_error(502)

    def _handle_control(self):
        """Local control channel for the Electron shell to register the
        top-level host before each navigation. Only matches requests made
        directly to the proxy in relative-path form (real forwarded HTTP
        proxy requests always use absolute-URI form per RFC 7230 5.3.2, so
        this can't collide with a real site's path). Token-gated because
        loopback destinations bypass this proxy in the browser's own proxy
        config, so a compromised tab could otherwise reach this port too."""
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != _CONTROL_PATH:
            return False
        qs = urllib.parse.parse_qs(parsed.query)
        token = (qs.get("token") or [""])[0]
        host = (qs.get("host") or [""])[0]
        action = (qs.get("action") or ["add"])[0]
        expected = _load_control_token()
        if not expected or not secrets.compare_digest(token, expected):
            self.send_error(403, "Invalid or missing control token")
            return True
        if host:
            if action == "remove":
                clear_current_top_level(host)
            else:
                set_current_top_level(host)
        self.send_response(204)
        self.end_headers()
        return True

    def do_GET(self):
        if self._handle_control():
            return
        self._forward()
    def do_POST(self):
        self._forward()
    def do_HEAD(self):
        self._forward()

    def _forward(self):
        if should_block_due_to_killswitch():
            self._kill_switch_block()
            return
        host = self._get_host_from_request()
        if not is_request_allowed(host):
            self._block_request(f"Destination '{host}' not in whitelist/current origin")
            return
        parsed = urllib.parse.urlparse(clean_url(self.path))
        scheme = parsed.scheme or 'http'
        sni_host = parsed.hostname or host
        port = parsed.port or (443 if scheme == 'https' else 80)
        path = urllib.parse.urlunparse(('', '', parsed.path or '/', parsed.params, parsed.query, ''))

        content_length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(content_length) if content_length else b""

        headers = sanitize_headers(dict(self.headers))
        headers = {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}
        headers, body = add_padding_to_request(headers, body)
        headers['Content-Length'] = str(len(body))
        headers['Host'] = sni_host

        try:
            if scheme == 'https':
                raw = _dns_connect(sni_host, port, timeout=15)
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(raw, server_hostname=sni_host)  # SNI/cert must use the real hostname, not the resolved IP
                conn = http.client.HTTPSConnection(sni_host, port, timeout=15)
                conn.sock = sock
            else:
                # Same pattern as the https branch above: HTTPConnection's own connect()
                # has the same local-getaddrinfo leak _dns_connect fixes (see its
                # SOCKS-branch comment) -- open the raw socket ourselves and hand it off
                # instead of letting HTTPConnection resolve/connect on its own.
                raw = _dns_connect(sni_host, port, timeout=15)
                conn = http.client.HTTPConnection(sni_host, port, timeout=15)
                conn.sock = raw

            conn.request(self.command, path or '/', body=body or None, headers=headers)
            resp = conn.getresponse()
            resp_body = resp.read()  # ponytail: buffered fully so a mid-stream error never leaves a partial write on the client
            conn.close()
        except Exception as e:
            audit_log("Network", f"Forward failed to {host}: {e}")
            self.send_error(502, "Celestial Proxy: upstream request failed")
            return

        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() in _HOP_BY_HOP:
                continue
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(resp_body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(resp_body)
        audit_log("Network", f"Forwarded {self.command} to {host}", blocked=False)

    def log_message(self, format, *args):
        pass

def _max_conn():
    return int(os.environ.get("CELESTIAL_MAX_CONN", "100"))

def _reject_with_503(request):
    """Write a properly framed 503 directly to the raw client socket and close it --
    used when the connection pool is saturated, before any handler/thread is spawned,
    so a saturated proxy rejects fast instead of accepting an unbounded backlog."""
    body = b"Celestial Proxy: connection limit reached, try again shortly"
    response = (
        b"HTTP/1.1 503 Service Unavailable\r\n"
        b"Content-Type: text/plain\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        b"Connection: close\r\n\r\n" + body
    )
    try:
        request.sendall(response)
    except Exception:
        pass
    finally:
        try:
            request.close()
        except Exception:
            pass

class ThreadedProxyServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._conn_semaphore = threading.BoundedSemaphore(_max_conn())

    def process_request(self, request, client_address):
        # ponytail: bounded via a semaphore rather than a fixed-size ThreadPoolExecutor --
        # same cap, no extra queue to manage, and rejection is immediate (non-blocking
        # acquire) instead of queuing behind a full pool.
        if not self._conn_semaphore.acquire(blocking=False):
            audit_log("CONN_LIMIT", f"Connection limit reached ({_max_conn()}), rejecting {client_address}")
            _reject_with_503(request)
            return

        def _run():
            try:
                self.process_request_thread(request, client_address)
            finally:
                self._conn_semaphore.release()

        t = threading.Thread(target=_run)
        t.daemon = self.daemon_threads
        t.start()

def run_proxy(port=None, config_path="desktop/config/vault_config.json"):
    load_config(config_path)
    if port is None:
        port = _config.get("proxy_port", 8080)
    server = ThreadedProxyServer(("", port), ProxyHandler)
    print(f"[PROXY] Celestial Privacy Proxy listening on 127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[PROXY] Shutting down...")
        server.shutdown()

if __name__ == "__main__":
    run_proxy()
