#!/usr/bin/env python3
"""Simple DoH Resolver for Celestial"""
import json
import urllib.request
import urllib.parse
from functools import lru_cache
from typing import List, Optional

DOH_PROVIDERS = {
    "cloudflare": "https://cloudflare-dns.com/dns-query",
    "google": "https://dns.google/resolve",
}

class DoHResolver:
    def __init__(self, provider: str = "cloudflare", timeout: float = 5.0):
        self.url = DOH_PROVIDERS.get(provider, DOH_PROVIDERS["cloudflare"])
        self.timeout = timeout
        self.headers = {"Accept": "application/dns-json", "User-Agent": "Celestial-DoH/1.0"}

    def resolve(self, hostname: str, record_type: str = "A") -> List[str]:
        if not hostname or '.' not in hostname:
            return []
        params = {"name": hostname, "type": record_type}
        query_string = urllib.parse.urlencode(params)
        full_url = f"{self.url}?{query_string}"
        try:
            req = urllib.request.Request(full_url, headers=self.headers)
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
                answers = data.get("Answer", [])
                return [ans["data"] for ans in answers if ans.get("type") in (1, 28)]
        except Exception as e:
            print(f"[DoH] Resolution failed for {hostname}: {e}")
            return []

_default_resolver = DoHResolver("cloudflare")

@lru_cache(maxsize=512)
def resolve_host(hostname: str) -> Optional[str]:
    # ponytail: no TTL, cache lives for process lifetime; add TTL eviction if hosts start changing IPs mid-run
    ips = _default_resolver.resolve(hostname)
    return ips[0] if ips else None

if __name__ == "__main__":
    calls = []
    real_resolve = DoHResolver.resolve
    DoHResolver.resolve = lambda self, hostname, record_type="A": (calls.append(hostname), ["1.2.3.4"])[1]
    resolve_host.cache_clear()
    assert resolve_host("example.com") == "1.2.3.4"
    assert resolve_host("example.com") == "1.2.3.4"
    assert len(calls) == 1, f"expected 1 network call, got {len(calls)}"
    DoHResolver.resolve = real_resolve
    print("OK: resolve_host caches repeated lookups")
