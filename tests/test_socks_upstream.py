"""Proves tunnel_manager.setup_socks5_upstream() plumbing is real end-to-end:
against a local throwaway SOCKS5 stub, is_socks_upstream_active() flips True and
a real socket.socket() connection is actually routed through it (not direct)."""
import socket as socket_mod
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "core"))

import tunnel_manager as tm


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("SOCKS5 stub: peer closed mid-handshake")
        buf += chunk
    return buf


class _MiniSocks5Server:
    """Just enough SOCKS5 (no-auth, CONNECT, IPv4/domain ATYP) to prove a real
    socket.socket() connect reaches this server. ponytail: hand-rolled -- no
    stdlib/already-installed dependency provides a throwaway SOCKS5 test server,
    and the no-auth CONNECT subset is ~50 lines."""

    def __init__(self):
        self.sock = socket_mod.socket(socket_mod.AF_INET, socket_mod.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.connect_targets = []
        self._stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        self.sock.settimeout(0.5)
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except socket_mod.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            conn.settimeout(3)
            _ver, nmethods = _recv_exact(conn, 2)
            _recv_exact(conn, nmethods)
            conn.sendall(bytes([0x05, 0x00]))  # no-auth selected

            _ver, _cmd, _rsv, atyp = _recv_exact(conn, 4)
            if atyp == 0x01:
                addr = socket_mod.inet_ntoa(_recv_exact(conn, 4))
            elif atyp == 0x03:
                length = _recv_exact(conn, 1)[0]
                addr = _recv_exact(conn, length).decode()
            else:
                addr = None
            port = struct.unpack(">H", _recv_exact(conn, 2))[0]
            self.connect_targets.append((addr, port))

            # Reply success with a dummy bind addr -- proving the CONNECT
            # handshake reached us is the whole point, no real relay needed.
            conn.sendall(bytes([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        except Exception:
            pass
        finally:
            conn.close()

    def stop(self):
        self._stop = True
        self.sock.close()


def test_setup_socks5_upstream_routes_through_local_server(monkeypatch):
    server = _MiniSocks5Server()
    orig_socket = socket_mod.socket
    try:
        monkeypatch.setattr(tm, "_config", {
            "enabled": True, "mode": "socks5",
            "upstream_host": "127.0.0.1", "upstream_port": server.port,
        })
        assert tm.setup_socks5_upstream() is True
        assert tm.is_socks_upstream_active() is True

        # setup_socks5_upstream() monkeypatches the global socket.socket to
        # socks.socksocket -- a plain connect() call must now go through our
        # SOCKS5 stub instead of attempting a direct connection.
        s = socket_mod.socket(socket_mod.AF_INET, socket_mod.SOCK_STREAM)
        s.settimeout(3)
        try:
            s.connect(("example.invalid", 9999))
        finally:
            s.close()

        time.sleep(0.2)
        assert server.connect_targets, "no CONNECT request reached the local SOCKS5 stub"
        assert server.connect_targets[0] == ("example.invalid", 9999)
    finally:
        socket_mod.socket = orig_socket
        tm._socks_upstream_active = False
        server.stop()
