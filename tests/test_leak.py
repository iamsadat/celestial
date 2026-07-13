"""Leak-vector regression guards: DNS must never reach the OS resolver when
DoH is active, DoH failure must fail closed (no connect with a bad host),
browser flags must close WebRTC/QUIC/prefetch leak vectors, and
strict_killswitch must be able to freeze traffic before any tunnel is
configured. Upstream is mocked throughout -- no real network/DNS/subprocess
(section 5 uses a local throwaway SOCKS5 stub, still no real network)."""
import time

import pytest

import custom_proxy as cp
import browser_launcher as bl
import tunnel_manager as tm
from test_proxy_forwarding import _make_handler
from test_socks_upstream import _MiniSocks5Server


class _FakeSocket:
    """Stand-in for a connected socket: supports the tunnel's recv/sendall
    loop (recv returns empty immediately so tunnel threads exit at once) and
    the `with _dns_connect(...) as sock:` context manager in do_CONNECT."""
    def recv(self, n): return b""
    def sendall(self, data): pass
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass


# ---- 1. DNS never leaks to the OS resolver --------------------------------

def test_dns_connect_uses_doh_ip_never_touches_getaddrinfo(monkeypatch):
    monkeypatch.setattr(cp, "is_socks_upstream_active", lambda: False)
    monkeypatch.setattr(cp, "resolve_host", lambda host: "203.0.113.9")

    getaddrinfo_calls = []
    monkeypatch.setattr(cp.socket, "getaddrinfo",
                         lambda *a, **kw: getaddrinfo_calls.append(a) or (_ for _ in ()).throw(RuntimeError("OS resolver touched")))

    connect_calls = []
    monkeypatch.setattr(cp.socket, "create_connection",
                         lambda address, timeout=None: connect_calls.append(address) or _FakeSocket())

    sock = cp._dns_connect("example.com", 443)

    assert connect_calls == [("203.0.113.9", 443)]  # connects via the DoH-resolved IP, not the hostname
    assert getaddrinfo_calls == []                   # OS resolver never invoked
    assert isinstance(sock, _FakeSocket)


def test_dns_connect_socks_active_connects_by_hostname_no_doh_call(monkeypatch):
    # Mocks cp.socket.socket (not create_connection): create_connection() does its own
    # getaddrinfo(host) before connect(), which is exactly the local-DNS leak this SOCKS
    # branch must avoid -- see test_socks_upstream_real_activation_dns_connect_uses_hostname_no_doh
    # below for the real (unmocked) end-to-end proof against a live SOCKS5 stub.
    monkeypatch.setattr(cp, "is_socks_upstream_active", lambda: True)
    monkeypatch.setattr(cp, "resolve_host",
                         lambda host: (_ for _ in ()).throw(AssertionError("DoH must be skipped under SOCKS")))

    connect_calls = []

    class _FakeConnectSocket(_FakeSocket):
        def settimeout(self, t): pass
        def connect(self, address): connect_calls.append(address)

    monkeypatch.setattr(cp.socket, "socket", lambda *a, **kw: _FakeConnectSocket())

    cp._dns_connect("example.com", 443)

    assert connect_calls == [("example.com", 443)]  # hostname handed off, SOCKS does remote (rdns) resolution


def test_connect_path_reaches_target_via_doh_ip(monkeypatch):
    # The actual bug _dns_connect fixed: raw CONNECT tunneling used to call
    # socket.create_connection(host, port) directly, leaking the hostname to
    # the OS resolver. Prove do_CONNECT now routes through _dns_connect.
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)

    calls = []
    monkeypatch.setattr(cp, "_dns_connect",
                         lambda host, port, timeout=15: calls.append((host, port)) or _FakeSocket())

    handler = _make_handler("CONNECT", "example.com:443")
    handler.connection = _FakeSocket()
    handler.do_CONNECT()

    assert calls == [("example.com", 443)]
    assert b"200" in handler.wfile.getvalue()


def test_forward_https_reaches_target_via_doh_ip(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "add_padding_to_request", lambda h, b=b"": (h, b))

    calls = []
    monkeypatch.setattr(cp, "_dns_connect",
                         lambda host, port, timeout=15: calls.append((host, port)) or _FakeSocket())

    class FakeCtx:
        def wrap_socket(self, raw, server_hostname=None): return raw
    monkeypatch.setattr(cp.ssl, "create_default_context", lambda: FakeCtx())

    class FakeResponse:
        status = 200
        reason = "OK"
        def getheaders(self): return []
        def read(self): return b"secure-body"

    class FakeHTTPSConn:
        def __init__(self, *a, **kw): pass
        def request(self, *a, **kw): pass
        def getresponse(self): return FakeResponse()
        def close(self): pass

    monkeypatch.setattr(cp.http.client, "HTTPSConnection", FakeHTTPSConn)

    handler = _make_handler("GET", "https://example.com/secure", {"Host": "example.com"})
    handler._forward()

    assert calls == [("example.com", 443)]
    assert b"200" in handler.wfile.getvalue()


# ---- 2. DoH failure fails closed -------------------------------------------

def test_dns_connect_raises_on_doh_failure(monkeypatch):
    monkeypatch.setattr(cp, "is_socks_upstream_active", lambda: False)
    monkeypatch.setattr(cp, "resolve_host", lambda host: None)
    monkeypatch.setattr(cp.socket, "create_connection",
                         lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not connect with no resolved host")))

    with pytest.raises(RuntimeError):
        cp._dns_connect("nowhere.invalid", 443)


def test_connect_doh_failure_returns_error_no_connect_attempted(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"nowhere.invalid"})
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "is_socks_upstream_active", lambda: False)
    monkeypatch.setattr(cp, "resolve_host", lambda host: None)
    monkeypatch.setattr(cp.socket, "create_connection",
                         lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not attempt connect with failed DoH")))

    handler = _make_handler("CONNECT", "nowhere.invalid:443")
    handler.connection = _FakeSocket()
    handler.do_CONNECT()

    assert b"502" in handler.wfile.getvalue()


def test_forward_https_doh_failure_returns_502_no_connect_attempted(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"nowhere.invalid"})
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "is_socks_upstream_active", lambda: False)
    monkeypatch.setattr(cp, "resolve_host", lambda host: None)
    monkeypatch.setattr(cp, "add_padding_to_request", lambda h, b=b"": (h, b))
    monkeypatch.setattr(cp.socket, "create_connection",
                         lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not attempt connect with failed DoH")))

    handler = _make_handler("GET", "https://nowhere.invalid/secret", {"Host": "nowhere.invalid"})
    handler._forward()

    resp = handler.wfile.getvalue()
    assert b"502" in resp
    assert b"secret" not in resp


# ---- 3. Browser flags close WebRTC/QUIC/prefetch leak vectors -------------

def test_browser_flags_close_leak_vectors_and_default_not_headless(monkeypatch):
    monkeypatch.delenv("CELESTIAL_HEADLESS", raising=False)
    monkeypatch.setattr(bl, "get_chrome_path", lambda: "/usr/bin/chromium")
    monkeypatch.setattr(bl, "set_current_top_level", lambda h: None)

    captured = {}
    class FakeProc:
        def wait(self): pass
    def fake_popen(cmd, env=None):
        captured["cmd"] = cmd
        return FakeProc()
    monkeypatch.setattr(bl.subprocess, "Popen", fake_popen)

    bl.launch_browser("https://example.com", proxy_port=8080)

    cmd = captured["cmd"]
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in cmd
    assert "--disable-quic" in cmd
    assert "--dns-prefetch-disable" in cmd
    assert any(f.startswith("--host-resolver-rules=") for f in cmd)
    assert "--headless=new" not in cmd


def test_browser_headless_flag_present_via_env(monkeypatch):
    monkeypatch.setenv("CELESTIAL_HEADLESS", "1")
    monkeypatch.setattr(bl, "get_chrome_path", lambda: "/usr/bin/chromium")
    monkeypatch.setattr(bl, "set_current_top_level", lambda h: None)

    captured = {}
    class FakeProc:
        def wait(self): pass
    def fake_popen(cmd, env=None):
        captured["cmd"] = cmd
        return FakeProc()
    monkeypatch.setattr(bl.subprocess, "Popen", fake_popen)

    bl.launch_browser("https://example.com", proxy_port=8080)

    assert "--headless=new" in captured["cmd"]


# ---- 4. Strict kill-switch fails closed before any tunnel is configured ---

def test_strict_killswitch_blocks_when_unhealthy_without_enabled_or_kill_switch(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"strict_killswitch": True})
    tm.set_tunnel_healthy(False, "test")
    assert tm.should_block_due_to_killswitch() is True


def test_strict_killswitch_allows_when_healthy(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"strict_killswitch": True})
    tm.set_tunnel_healthy(True, "test")
    assert tm.should_block_due_to_killswitch() is False
    tm.set_tunnel_healthy(True, "test")  # leave healthy for other tests


# ---- 5. Real SOCKS5 activation routes _dns_connect by hostname, skips DoH -

def test_socks_upstream_real_activation_dns_connect_uses_hostname_no_doh(monkeypatch):
    """Extends section 1 (DNS never leaks): here the SOCKS5 upstream is a real,
    locally-bound stub (not a mocked is_socks_upstream_active) -- proves
    setup_socks5_upstream() actually flips the live flag cp._dns_connect reads,
    and that a real socket.socket() connect goes to the SOCKS5 stub by hostname
    instead of ever calling resolve_host (DoH)."""
    server = _MiniSocks5Server()
    orig_socket = cp.socket.socket
    try:
        monkeypatch.setattr(tm, "_config", {
            "enabled": True, "mode": "socks5",
            "upstream_host": "127.0.0.1", "upstream_port": server.port,
        })
        assert tm.setup_socks5_upstream() is True
        assert cp.is_socks_upstream_active() is True  # real flip, read through cp's own import

        monkeypatch.setattr(cp, "resolve_host",
                             lambda host: (_ for _ in ()).throw(AssertionError("DoH must be skipped under real SOCKS activation")))

        sock = cp._dns_connect("example.invalid", 9999, timeout=3)
        sock.close()

        time.sleep(0.2)  # let the stub's accept thread record the CONNECT
        assert server.connect_targets == [("example.invalid", 9999)]
    finally:
        cp.socket.socket = orig_socket
        tm._socks_upstream_active = False
        server.stop()


# ---- 6. Strict kill-switch, driven end-to-end, blocks _forward() with zero
#         forwarding attempts (extends leak_check.py check (b) as a pytest) --

def test_strict_killswitch_forward_blocks_with_zero_forwarding_attempts(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"strict_killswitch": True})
    tm.set_tunnel_healthy(False, "test")
    assert cp.should_block_due_to_killswitch() is True  # real decision, not mocked

    monkeypatch.setattr(cp, "resolve_host",
                         lambda host: (_ for _ in ()).throw(AssertionError("no DNS resolution while kill-switch blocks")))
    monkeypatch.setattr(cp.socket, "create_connection",
                         lambda *a, **kw: (_ for _ in ()).throw(AssertionError("no connect attempted while kill-switch blocks")))

    handler = _make_handler("GET", "http://example.com/secret", {"Host": "example.com"})
    handler._forward()

    resp = handler.wfile.getvalue()
    assert b"503" in resp
    assert b"secret" not in resp  # zero bytes of the request ever forwarded
    tm.set_tunnel_healthy(True, "test")  # leave healthy for other tests
