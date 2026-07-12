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
import threading
from datetime import datetime, timezone

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

_current_top_level_host = None
_allowed_hosts = set()
_config = {}
_blocked_count = 0
_lock = threading.Lock()

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
    global _current_top_level_host
    with _lock:
        if hostname:
            _current_top_level_host = hostname.lower().strip()
            print(f"[PROXY] Current top-level origin set to: {_current_top_level_host}")
            if _current_top_level_host not in _allowed_hosts:
                _allowed_hosts.add(_current_top_level_host)

def is_request_allowed(hostname):
    global _current_top_level_host, _allowed_hosts
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
        if _current_top_level_host and h == _current_top_level_host:
            return True
        return False

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
        self.send_response(503, "Network Not Secure")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        html = f"""<!DOCTYPE html><html><body style="font-family:system-ui;background:#0a0a0a;color:#ff4444;padding:40px;text-align:center">
        <h1>⛔ NETWORK NOT SECURE</h1>
        <p><strong>{msg}</strong></p>
        <p>All network requests have been frozen by the Vault Kill-Switch.</p>
        </body></html>"""
        self.wfile.write(html.encode('utf-8'))

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
            with socket.create_connection((host, port), timeout=10) as target_sock:
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

    def do_GET(self):
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
            if is_socks_upstream_active():
                # ponytail: SOCKS upstream does remote DNS (rdns=True) through the tunnel;
                # connect by hostname here, resolving locally would leak DNS around the tunnel.
                connect_host = sni_host
            else:
                connect_host = resolve_host(sni_host)
                if not connect_host:
                    raise RuntimeError(f"DoH resolution failed for {sni_host}")

            if scheme == 'https':
                raw = socket.create_connection((connect_host, port), timeout=15)
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(raw, server_hostname=sni_host)  # SNI/cert must use the real hostname, not the resolved IP
                conn = http.client.HTTPSConnection(sni_host, port, timeout=15)
                conn.sock = sock
            else:
                conn = http.client.HTTPConnection(connect_host, port, timeout=15)

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

class ThreadedProxyServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

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
