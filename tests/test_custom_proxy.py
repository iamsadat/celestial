"""is_request_allowed() is the whitelist/tracker gate every request passes
through: trackers always blocked, unknown hosts blocked, whitelisted or
current-origin hosts allowed."""
import custom_proxy as cp


def test_tracker_domain_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    assert cp.is_request_allowed("google-analytics.com") is False


def test_tracker_subdomain_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    assert cp.is_request_allowed("ads.doubleclick.net") is False


def test_non_whitelisted_host_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    assert cp.is_request_allowed("example.com") is False


def test_whitelisted_host_allowed(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", {"example.com"})
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    assert cp.is_request_allowed("example.com") is True


def test_current_top_level_origin_allowed(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    cp.set_current_top_level("foo.com")
    assert cp.is_request_allowed("foo.com") is True


def test_empty_hostname_blocked(monkeypatch):
    monkeypatch.setattr(cp, "_allowed_hosts", set())
    monkeypatch.setattr(cp, "_current_top_level_host", None)
    assert cp.is_request_allowed("") is False
