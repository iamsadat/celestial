"""ThreadedProxyServer bounds concurrent connections (CELESTIAL_MAX_CONN,
default 100) instead of spawning an unbounded thread per connection. A
saturated proxy must reject fast with a properly framed 503 (Content-Length
set, socket closed) rather than hanging or accepting an unbounded backlog."""
import threading

import custom_proxy as cp


def test_max_conn_defaults_to_100(monkeypatch):
    monkeypatch.delenv("CELESTIAL_MAX_CONN", raising=False)
    assert cp._max_conn() == 100


def test_max_conn_reads_env_override(monkeypatch):
    monkeypatch.setenv("CELESTIAL_MAX_CONN", "7")
    assert cp._max_conn() == 7


class _FakeSocket:
    def __init__(self):
        self.sent = b""
        self.closed = False

    def sendall(self, data):
        self.sent += data

    def close(self):
        self.closed = True


def test_process_request_serves_when_under_capacity(monkeypatch):
    server = cp.ThreadedProxyServer.__new__(cp.ThreadedProxyServer)
    server._conn_semaphore = threading.BoundedSemaphore(2)
    server.daemon_threads = True

    handled = threading.Event()
    monkeypatch.setattr(server, "process_request_thread",
                         lambda request, client_address: handled.set(), raising=False)

    server.process_request(_FakeSocket(), ("127.0.0.1", 1234))
    assert handled.wait(timeout=2)


def test_process_request_rejects_with_framed_503_when_saturated():
    server = cp.ThreadedProxyServer.__new__(cp.ThreadedProxyServer)
    server._conn_semaphore = threading.BoundedSemaphore(1)
    server._conn_semaphore.acquire()  # saturate the one available slot
    server.daemon_threads = True

    def _should_not_run(request, client_address):
        raise AssertionError("must not spawn a handler thread when saturated")
    server.process_request_thread = _should_not_run

    fake = _FakeSocket()
    server.process_request(fake, ("127.0.0.1", 1234))

    assert b"503" in fake.sent
    assert b"Content-Length: " in fake.sent
    assert fake.closed is True


def test_saturated_slot_frees_after_handler_completes():
    server = cp.ThreadedProxyServer.__new__(cp.ThreadedProxyServer)
    server._conn_semaphore = threading.BoundedSemaphore(1)
    server.daemon_threads = True

    done = threading.Event()
    server.process_request_thread = lambda request, client_address: done.set()

    server.process_request(_FakeSocket(), ("127.0.0.1", 1))
    assert done.wait(timeout=2)

    # semaphore must be released once the handler thread finishes, allowing
    # the next connection through instead of staying permanently saturated
    assert server._conn_semaphore.acquire(blocking=True, timeout=2)
