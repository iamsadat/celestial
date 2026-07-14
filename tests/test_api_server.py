"""/config exposes and rewrites the whitelist/kill-switch config, so it must
require the shared-secret X-Celestial-Token header. POST also validates the
network_obfuscation fields, merges (never clobbers) into the persisted file,
masks the stored password on GET, and re-arms the upstream tunnel."""
import json

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient
import api_server as srv

client = TestClient(srv.app)
AUTH = {"X-Celestial-Token": srv._API_TOKEN}


def test_config_without_token_is_unauthorized():
    resp = client.get("/config")
    assert resp.status_code == 401


def test_config_with_valid_token_is_ok():
    resp = client.get("/config", headers=AUTH)
    assert resp.status_code == 200


def test_config_with_wrong_token_is_unauthorized():
    resp = client.get("/config", headers={"X-Celestial-Token": "wrong-token"})
    assert resp.status_code == 401


def test_health_needs_no_token():
    resp = client.get("/health")
    assert resp.status_code == 200


@pytest.fixture
def config_file(tmp_path, monkeypatch):
    path = tmp_path / "vault_config.json"
    monkeypatch.setattr(srv, "_CONFIG_PATH", path)
    monkeypatch.setattr(srv, "setup_upstream_if_needed", lambda: False)
    monkeypatch.setattr(srv, "load_tunnel_config", lambda config_path=None: None)
    return path


def test_config_post_rejects_out_of_range_port(config_file):
    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"upstream_port": 70000}})
    assert resp.status_code == 422


def test_config_post_rejects_unknown_mode(config_file):
    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"mode": "http"}})
    assert resp.status_code == 422


def test_config_post_merges_without_clobbering_other_keys(config_file):
    config_file.write_text(json.dumps({
        "proxy_port": 8080,
        "whitelist": ["example.com"],
        "network_obfuscation": {
            "enabled": False, "mode": "socks5", "upstream_host": "old.host",
            "upstream_port": 1080, "username": None, "password": "s3cret",
            "kill_switch": True, "strict_killswitch": False,
            "enable_packet_padding": True, "padding_min_bytes": 64, "padding_max_bytes": 512,
        },
    }))

    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"enabled": True, "upstream_host": "new.host"}})
    assert resp.status_code == 200

    saved = json.loads(config_file.read_text())
    assert saved["whitelist"] == ["example.com"]          # untouched top-level key preserved
    assert saved["proxy_port"] == 8080                    # untouched top-level key preserved
    net = saved["network_obfuscation"]
    assert net["enabled"] is True                         # updated
    assert net["upstream_host"] == "new.host"              # updated
    assert net["upstream_port"] == 1080                    # preserved, not clobbered
    assert net["password"] == "s3cret"                      # preserved, not clobbered
    assert net["padding_min_bytes"] == 64                   # preserved, not clobbered


def test_config_get_masks_password_when_set(config_file):
    config_file.write_text(json.dumps({
        "network_obfuscation": {"enabled": True, "password": "real-secret"},
    }))
    resp = client.get("/config", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["network_obfuscation"]["password"] == "***"


def test_config_get_does_not_mask_when_no_password_set(config_file):
    config_file.write_text(json.dumps({"network_obfuscation": {"enabled": False}}))
    resp = client.get("/config", headers=AUTH)
    assert "password" not in resp.json()["network_obfuscation"]


def test_config_post_mask_sentinel_preserves_stored_password(config_file):
    config_file.write_text(json.dumps({
        "network_obfuscation": {"password": "real-secret", "upstream_host": "h"},
    }))
    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"password": "***", "upstream_host": "h2"}})
    assert resp.status_code == 200

    saved = json.loads(config_file.read_text())
    assert saved["network_obfuscation"]["password"] == "real-secret"  # sentinel did not clobber it
    assert saved["network_obfuscation"]["upstream_host"] == "h2"


def test_config_post_real_password_overwrites_stored_value(config_file):
    config_file.write_text(json.dumps({"network_obfuscation": {"password": "old"}}))
    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"password": "new-secret"}})
    assert resp.status_code == 200
    saved = json.loads(config_file.read_text())
    assert saved["network_obfuscation"]["password"] == "new-secret"


def test_config_post_calls_setup_upstream_if_needed(config_file, monkeypatch):
    called = []
    monkeypatch.setattr(srv, "setup_upstream_if_needed", lambda: called.append(True))
    resp = client.post("/config", headers=AUTH,
                        json={"network_obfuscation": {"enabled": True}})
    assert resp.status_code == 200
    assert called == [True]


def test_config_post_skips_upstream_setup_when_untouched(config_file, monkeypatch):
    called = []
    monkeypatch.setattr(srv, "setup_upstream_if_needed", lambda: called.append(True))
    resp = client.post("/config", headers=AUTH, json={"whitelist": ["foo.com"]})
    assert resp.status_code == 200
    assert called == []
