"""Exercises app/ml/osrm_client.py against a real local HTTP server (http.server, a real socket
— not a mocked httpx transport) for every distinct failure mode, mirroring
core/test/eta-osrm-fallback.test.ts's rigor and, specifically, its "no route found" case: a real
OSRM instance signals routing failure via HTTP 400 with a `{"code": "NoSegment"|"NoRoute", ...}`
body (verified against a real running container, see docs/osrm-routing.md) — genuinely different
from this same service's own 200-with-error-code /predict-eta convention, so this is tested
explicitly rather than assumed.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.ml.osrm_client import fetch_osrm_route

PICKUP = (37.7749, -122.4194)
DROPOFF = (37.8044, -122.2712)


def _respond(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    payload = json.dumps(body).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class _StubServer:
    """A real, addressable HTTP server on a random loopback port — genuine socket/timeout
    behavior, not a mocked transport (same "real infrastructure over mocks" standard as
    core/test/helpers/osrm-stub-server.ts)."""

    def __init__(self, handler_fn):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 (stdlib method name)
                handler_fn(self)

            def log_message(self, fmt, *args):  # silence default stderr access logging
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        outer.closed = False

    @property
    def url(self) -> str:
        _, port = self.server.server_address
        return f"http://127.0.0.1:{port}"

    def close(self) -> None:
        if self.closed:
            return
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.closed = True


@pytest.fixture
def start_stub():
    servers = []

    def _start(handler_fn) -> _StubServer:
        s = _StubServer(handler_fn)
        servers.append(s)
        return s

    yield _start
    for s in servers:
        s.close()


def ok_handler(distance_meters: float, duration_seconds: float):
    def handler_fn(handler: BaseHTTPRequestHandler) -> None:
        _respond(
            handler,
            200,
            {
                "code": "Ok",
                "routes": [{"distance": distance_meters, "duration": duration_seconds}],
                "waypoints": [],
            },
        )

    return handler_fn


def slow_handler(delay_seconds: float, distance_meters: float, duration_seconds: float):
    def handler_fn(handler: BaseHTTPRequestHandler) -> None:
        time.sleep(delay_seconds)
        _respond(
            handler,
            200,
            {
                "code": "Ok",
                "routes": [{"distance": distance_meters, "duration": duration_seconds}],
                "waypoints": [],
            },
        )

    return handler_fn


def no_route_handler(code: str = "NoSegment"):
    def handler_fn(handler: BaseHTTPRequestHandler) -> None:
        _respond(handler, 400, {"code": code, "message": f"simulated {code}"})

    return handler_fn


def error_status_handler(status_code: int):
    def handler_fn(handler: BaseHTTPRequestHandler) -> None:
        _respond(handler, status_code, {"detail": "simulated osrm error"})

    return handler_fn


def malformed_handler(handler: BaseHTTPRequestHandler) -> None:
    _respond(handler, 200, {"code": "Ok", "unexpected": "shape"})


def test_returns_the_real_route_on_success(start_stub):
    stub = start_stub(ok_handler(2552.4, 368.5))
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is True
    assert result.route.distance_meters == 2552.4
    assert result.route.duration_seconds == 368.5


def test_no_route_found_via_no_segment_code_http_400(start_stub):
    """The real, verified OSRM contract: routing failure is HTTP 400 + a structured body, not a
    200 with an in-body error the way ml-service's own /predict-eta signals failure."""
    stub = start_stub(no_route_handler("NoSegment"))
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is False
    assert result.reason == "no_route"
    assert "NoSegment" in result.detail


def test_no_route_found_via_no_route_code_http_400(start_stub):
    stub = start_stub(no_route_handler("NoRoute"))
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is False
    assert result.reason == "no_route"


def test_unreachable_when_nothing_is_listening(start_stub):
    stub = start_stub(ok_handler(1000.0, 100.0))
    stub.close()  # nothing is listening at this URL anymore
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is False
    assert result.reason == "unreachable"


def test_timeout_when_osrm_is_too_slow(start_stub):
    stub = start_stub(slow_handler(2.0, 1000.0, 100.0))  # far beyond the 0.2s timeout below
    started = time.monotonic()
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=0.2)
    elapsed = time.monotonic() - started
    assert result.ok is False
    assert result.reason == "timeout"
    # Proves this is a genuine abort around ~0.2s, not the full 2s the stub takes to respond.
    assert elapsed < 1.0


def test_error_status_for_a_non_routing_failure(start_stub):
    stub = start_stub(error_status_handler(500))
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is False
    assert result.reason == "error_status"


def test_malformed_response_body(start_stub):
    stub = start_stub(malformed_handler)
    result = fetch_osrm_route(stub.url, *PICKUP, *DROPOFF, timeout_seconds=2.0)
    assert result.ok is False
    assert result.reason == "malformed_response"
