"""resolve_host() is lru_cache-wrapped; repeated lookups of the same host
must not hit the network twice."""
import doh_resolver as dr


def test_resolve_host_caches_repeated_lookups(monkeypatch):
    calls = []

    def fake_resolve(self, hostname, record_type="A"):
        calls.append(hostname)
        return ["1.2.3.4"]

    monkeypatch.setattr(dr.DoHResolver, "resolve", fake_resolve)
    dr.resolve_host.cache_clear()

    assert dr.resolve_host("example.com") == "1.2.3.4"
    assert dr.resolve_host("example.com") == "1.2.3.4"
    assert len(calls) == 1


def test_resolve_host_returns_none_when_no_answers(monkeypatch):
    monkeypatch.setattr(dr.DoHResolver, "resolve", lambda self, hostname, record_type="A": [])
    dr.resolve_host.cache_clear()
    assert dr.resolve_host("nowhere.invalid") is None
