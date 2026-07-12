"""/config exposes and rewrites the whitelist/kill-switch config, so it must
require the shared-secret X-Celestial-Token header."""
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient
import api_server as srv

client = TestClient(srv.app)


def test_config_without_token_is_unauthorized():
    resp = client.get("/config")
    assert resp.status_code == 401


def test_config_with_valid_token_is_ok():
    resp = client.get("/config", headers={"X-Celestial-Token": srv._API_TOKEN})
    assert resp.status_code == 200


def test_config_with_wrong_token_is_unauthorized():
    resp = client.get("/config", headers={"X-Celestial-Token": "wrong-token"})
    assert resp.status_code == 401


def test_health_needs_no_token():
    resp = client.get("/health")
    assert resp.status_code == 200
