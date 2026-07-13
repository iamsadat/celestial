"""Config schema regression guard: the example config must parse and expose
the documented network_obfuscation keys, and tunnel_manager must read them
into _config exactly as documented -- prevents the example drifting out of
sync with what load_tunnel_config actually consumes."""
import json
from pathlib import Path

import tunnel_manager as tm

EXAMPLE_CONFIG_PATH = Path(__file__).parent.parent / "desktop/config/vault_config.example.json"

EXPECTED_OBFUSCATION_KEYS = {
    "enabled", "mode", "upstream_host", "upstream_port", "username", "password",
    "kill_switch", "strict_killswitch", "enable_packet_padding",
    "padding_min_bytes", "padding_max_bytes",
}


def test_example_config_parses_and_has_documented_keys():
    with open(EXAMPLE_CONFIG_PATH) as f:
        full = json.load(f)

    assert "network_obfuscation" in full
    assert set(full["network_obfuscation"].keys()) == EXPECTED_OBFUSCATION_KEYS
    assert "proxy_port" in full
    assert "whitelist" in full


def test_load_tunnel_config_reads_example_into_config():
    tm.load_tunnel_config(str(EXAMPLE_CONFIG_PATH))
    with open(EXAMPLE_CONFIG_PATH) as f:
        expected = json.load(f)["network_obfuscation"]

    assert tm._config == expected
