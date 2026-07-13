"""Static/offline regression guards for the Electron-side privacy hardening
that can't be exercised without a full Electron runtime (out of scope here):
kill-switch source shape and fingerprint shim syntax + surface coverage."""
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
APP_DIR = REPO_ROOT / "app"


def test_killswitch_static_shape_check_passes():
    result = subprocess.run(
        ["node", str(APP_DIR / "verify_killswitch.js")],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS" in result.stdout


def test_fingerprint_preload_syntax_valid():
    result = subprocess.run(
        ["node", "--check", str(APP_DIR / "fingerprint-preload.js")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def test_fingerprint_preload_covers_intended_surfaces():
    src = (APP_DIR / "fingerprint-preload.js").read_text()
    for surface in (
        "hardwareConcurrency", "deviceMemory", "platform", "languages",
        "getImageData", "toDataURL", "getParameter",
        "UNMASKED_VENDOR_WEBGL", "UNMASKED_RENDERER_WEBGL",
    ):
        assert surface in src, f"fingerprint shim missing expected surface: {surface}"
