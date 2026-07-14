"""The multi-tab Electron shell registers/clears its top-level hosts through
the token-gated /__celestial/set-top-level control channel. Covers: token
gating, add/remove actions, the bounded-LRU active set (task: per-tab proxy
identity), and that is_request_allowed() passes for ANY active top-level."""
import http.client
import io
from collections import OrderedDict

import custom_proxy as cp


def _make_control_handler(query):
    handler = cp.ProxyHandler.__new__(cp.ProxyHandler)
    handler.command = "GET"
    handler.path = f"{cp._CONTROL_PATH}?{query}"
    handler.request_version = "HTTP/1.1"
    handler.requestline = f"GET {handler.path} HTTP/1.1"
    handler.client_address = ("127.0.0.1", 55555)
    handler.headers = http.client.parse_headers(io.BytesIO(b"\r\n"))
    handler.rfile = io.BytesIO(b"")
    handler.wfile = io.BytesIO()
    return handler


def test_control_endpoint_rejects_missing_token(monkeypatch):
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    handler = _make_control_handler("host=foo.com")
    assert handler._handle_control() is True
    assert b"403" in handler.wfile.getvalue()
    assert "foo.com" not in cp._active_top_levels


def test_control_endpoint_rejects_wrong_token(monkeypatch):
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "_load_control_token", lambda: "right-token")
    handler = _make_control_handler("host=foo.com&token=wrong-token")
    assert handler._handle_control() is True
    assert b"403" in handler.wfile.getvalue()
    assert "foo.com" not in cp._active_top_levels


def test_control_endpoint_add_registers_host(monkeypatch):
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    monkeypatch.setattr(cp, "_load_control_token", lambda: "tok")
    handler = _make_control_handler("host=foo.com&token=tok")
    assert handler._handle_control() is True
    assert b"204" in handler.wfile.getvalue()
    assert "foo.com" in cp._active_top_levels


def test_control_endpoint_remove_clears_host(monkeypatch):
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict({"foo.com": None}))
    monkeypatch.setattr(cp, "_load_control_token", lambda: "tok")
    handler = _make_control_handler("host=foo.com&token=tok&action=remove")
    assert handler._handle_control() is True
    assert "foo.com" not in cp._active_top_levels


def test_non_control_path_is_not_handled():
    handler = _make_control_handler("host=foo.com")
    handler.path = "/some/other/path"
    assert handler._handle_control() is False


def test_multiple_tabs_are_all_allowed_simultaneously(monkeypatch):
    """Core of the per-tab identity fix: two live tabs' top-level hosts must
    BOTH be allowed at once (a single shared 'current host' string used to
    misfire third-party checks across tabs)."""
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    cp.set_current_top_level("tab-a.com")
    cp.set_current_top_level("tab-b.com")
    assert cp.is_request_allowed("tab-a.com") is True
    assert cp.is_request_allowed("tab-b.com") is True
    assert cp.is_request_allowed("tab-c.com") is False


def test_clear_current_top_level_revokes_access(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    cp.set_current_top_level("tab-a.com")
    assert cp.is_request_allowed("tab-a.com") is True
    cp.clear_current_top_level("tab-a.com")
    assert cp.is_request_allowed("tab-a.com") is False


def test_active_top_levels_bounded_with_lru_eviction(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    for i in range(cp._MAX_ACTIVE_TOP_LEVELS):
        cp.set_current_top_level(f"host{i}.com")
    assert len(cp._active_top_levels) == cp._MAX_ACTIVE_TOP_LEVELS

    # one more insertion evicts the least-recently-used (host0.com)
    cp.set_current_top_level("host-new.com")
    assert len(cp._active_top_levels) == cp._MAX_ACTIVE_TOP_LEVELS
    assert cp.is_request_allowed("host0.com") is False
    assert cp.is_request_allowed("host-new.com") is True


def test_re_registering_host_refreshes_lru_position(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_active_top_levels", OrderedDict())
    for i in range(cp._MAX_ACTIVE_TOP_LEVELS):
        cp.set_current_top_level(f"host{i}.com")

    # touch host0.com again -- it should no longer be the LRU candidate
    cp.set_current_top_level("host0.com")
    cp.set_current_top_level("host-new.com")

    assert cp.is_request_allowed("host0.com") is True    # refreshed, survives eviction
    assert cp.is_request_allowed("host1.com") is False   # was actually the LRU, now evicted
