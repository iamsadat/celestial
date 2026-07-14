"""_forward() is the fail-closed core of the proxy: blocked/tracker hosts
never reach a connect attempt, kill-switch freezes before any connect, and
an upstream failure returns 502 with nothing of the request/response leaked
to the client. Upstream is mocked throughout -- no real network."""
import http.client
import io
from collections import OrderedDict

import custom_proxy as cp


def _make_handler(method="GET", path="/", headers=None, body=b""):
    handler = cp.ProxyHandler.__new__(cp.ProxyHandler)
    handler.command = method
    handler.path = path
    handler.request_version = "HTTP/1.1"
    handler.requestline = f"{method} {path} HTTP/1.1"
    handler.client_address = ("127.0.0.1", 55555)
    raw = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items()) + "\r\n"
    handler.headers = http.client.parse_headers(io.BytesIO(raw.encode()))
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    return handler


def test_forward_unreachable_target_fails_closed(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"bogus.invalid"})
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "_dns_connect", lambda host, port, timeout=15: object())

    class FakeConn:
        def __init__(self, *a, **kw): pass
        def request(self, *a, **kw): raise ConnectionRefusedError("refused")
        def getresponse(self): raise AssertionError("should not reach getresponse")
        def close(self): pass

    monkeypatch.setattr(cp.http.client, "HTTPConnection", FakeConn)

    handler = _make_handler("GET", "http://bogus.invalid/secret-path?token=abc",
                             {"Host": "bogus.invalid"})
    handler._forward()

    resp = handler.wfile.getvalue()
    assert b"502" in resp
    assert b"secret-path" not in resp
    assert b"token=abc" not in resp


def test_forward_non_whitelisted_host_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "resolve_host",
                         lambda host: (_ for _ in ()).throw(AssertionError("no DoH for blocked host")))

    handler = _make_handler("GET", "http://example.com/", {"Host": "example.com"})
    handler._forward()

    assert b"403" in handler.wfile.getvalue()


def test_forward_tracker_domain_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)

    handler = _make_handler("GET", "http://google-analytics.com/collect",
                             {"Host": "google-analytics.com"})
    handler._forward()

    assert b"403" in handler.wfile.getvalue()


def test_forward_allowed_host_sanitizes_and_forwards(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "_dns_connect", lambda host, port, timeout=15: object())
    monkeypatch.setattr(cp, "add_padding_to_request", lambda h, b=b"": (h, b))

    captured = {}

    class FakeResponse:
        status = 200
        reason = "OK"
        def getheaders(self):
            return [("Content-Type", "text/plain"), ("Connection", "close")]
        def read(self):
            return b"hello"

    class FakeConn:
        def __init__(self, *a, **kw): pass
        def request(self, method, path, body=None, headers=None):
            captured["method"] = method
            captured["path"] = path
            captured["headers"] = headers
        def getresponse(self):
            return FakeResponse()
        def close(self): pass

    monkeypatch.setattr(cp.http.client, "HTTPConnection", FakeConn)

    handler = _make_handler(
        "GET",
        "http://example.com/page?utm_source=ads&keep=1",
        {"Host": "example.com", "Referer": "http://evil.example/", "Connection": "keep-alive"},
    )
    handler._forward()

    assert captured["path"] == "/page?keep=1"          # tracking param stripped
    assert "Referer" not in captured["headers"]          # sanitize_headers
    assert "Connection" not in captured["headers"]       # hop-by-hop stripped
    assert captured["headers"]["Content-Length"] == "0"

    resp = handler.wfile.getvalue()
    assert b"200" in resp
    assert b"Content-Length: 5" in resp
    assert b"hello" in resp
    assert b"Connection: close" not in resp              # hop-by-hop stripped from response too


def test_forward_blocked_by_killswitch_no_connect_attempted(monkeypatch):
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: True)
    monkeypatch.setattr(cp, "resolve_host",
                         lambda host: (_ for _ in ()).throw(AssertionError("no connect while kill-switch active")))

    handler = _make_handler("GET", "http://example.com/", {"Host": "example.com"})
    handler._forward()

    resp = handler.wfile.getvalue()
    assert b"503" in resp
    assert "NETWORK NOT SECURE".encode() in resp


def test_forward_socks_active_skips_local_dns(monkeypatch):
    # DNS-leak invariant: _forward() must hand the raw hostname to _dns_connect (which
    # owns the SOCKS-vs-DoH branching -- see its own tests in test_leak.py), never a
    # locally resolved IP, and never call resolve_host() itself.
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "resolve_host",
                         lambda host: (_ for _ in ()).throw(AssertionError("DoH must be skipped under SOCKS")))
    monkeypatch.setattr(cp, "add_padding_to_request", lambda h, b=b"": (h, b))

    captured = {}
    monkeypatch.setattr(cp, "_dns_connect",
                         lambda host, port, timeout=15: captured.setdefault("connect_host", host) or object())

    class FakeResponse:
        status = 200
        reason = "OK"
        def getheaders(self): return []
        def read(self): return b"ok"

    class FakeConn:
        def __init__(self, *a, **kw): pass
        def request(self, *a, **kw): pass
        def getresponse(self): return FakeResponse()
        def close(self): pass

    monkeypatch.setattr(cp.http.client, "HTTPConnection", FakeConn)

    handler = _make_handler("GET", "http://example.com/", {"Host": "example.com"})
    handler._forward()

    assert captured["connect_host"] == "example.com"  # connects by hostname, not a resolved IP
    assert b"200" in handler.wfile.getvalue()


def test_forward_head_request_writes_no_body(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "should_block_due_to_killswitch", lambda: False)
    monkeypatch.setattr(cp, "_dns_connect", lambda host, port, timeout=15: object())
    monkeypatch.setattr(cp, "add_padding_to_request", lambda h, b=b"": (h, b))

    class FakeResponse:
        status = 200
        reason = "OK"
        def getheaders(self): return []
        def read(self): return b"hidden-body"

    class FakeConn:
        def __init__(self, *a, **kw): pass
        def request(self, *a, **kw): pass
        def getresponse(self): return FakeResponse()
        def close(self): pass

    monkeypatch.setattr(cp.http.client, "HTTPConnection", FakeConn)

    handler = _make_handler("HEAD", "http://example.com/", {"Host": "example.com"})
    handler._forward()

    resp = handler.wfile.getvalue()
    assert b"200" in resp
    assert b"Content-Length: 11" in resp  # len("hidden-body"), reported even though body is withheld
    assert b"hidden-body" not in resp
