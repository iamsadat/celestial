"""Kill-switch is the core privacy invariant: if the tunnel is down and the
kill-switch is armed, should_block_due_to_killswitch() must be True. If
obfuscation is disabled in config, it must never block regardless of health."""
import tunnel_manager as tm


def test_killswitch_blocks_when_unhealthy(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"enabled": True, "kill_switch": True})
    tm.set_tunnel_healthy(False, "test")
    assert tm.should_block_due_to_killswitch() is True


def test_killswitch_clears_when_healthy(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"enabled": True, "kill_switch": True})
    tm.set_tunnel_healthy(True, "test")
    assert tm.should_block_due_to_killswitch() is False


def test_killswitch_never_blocks_when_obfuscation_disabled(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"enabled": False, "kill_switch": True})
    tm.set_tunnel_healthy(False, "test")
    assert tm.should_block_due_to_killswitch() is False


def test_killswitch_never_blocks_when_flag_off(monkeypatch):
    monkeypatch.setattr(tm, "_config", {"enabled": True, "kill_switch": False})
    tm.set_tunnel_healthy(False, "test")
    assert tm.should_block_due_to_killswitch() is False


def test_is_tunnel_healthy_reflects_set_tunnel_healthy():
    tm.set_tunnel_healthy(True, "test")
    assert tm.is_tunnel_healthy() is True
    tm.set_tunnel_healthy(False, "test")
    assert tm.is_tunnel_healthy() is False
    tm.set_tunnel_healthy(True, "test")  # leave healthy for other tests
