"""Real road-network routing via OSRM (Phase 15, docs/osrm-routing.md) — used by
scripts/train_model.py to compute a per-trip `osrm_duration_seconds`/`osrm_distance_meters`
feature for the retrained model. Mirrors core/src/services/osrm-client.ts's design (a
discriminated result instead of raising, so callers can distinguish failure modes) and,
critically, its corrected parsing order: OSRM signals a routing failure (e.g. a point that can't
be snapped to a road, `NoSegment`/`NoRoute`) via **HTTP 400** with a JSON body
`{"code": "NoSegment", "message": "..."}` — not a 200-with-error-code the way this same service's
own /predict-eta does. So the body is always parsed as JSON first, regardless of HTTP status, and
a recognizable non-"Ok" `code` is treated as "no_route" before falling back to
status/shape-based classification. Verified against a real running OSRM container, not assumed —
see docs/osrm-routing.md.
"""

from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class OsrmRoute:
    distance_meters: float
    duration_seconds: float


@dataclass
class OsrmResult:
    ok: bool
    route: OsrmRoute | None = None
    # "unreachable" | "timeout" | "no_route" | "error_status" | "malformed_response"
    reason: str | None = None
    detail: str | None = None


def fetch_osrm_route(
    osrm_url: str,
    pickup_lat: float,
    pickup_lng: float,
    dropoff_lat: float,
    dropoff_lng: float,
    timeout_seconds: float,
) -> OsrmResult:
    url = (
        f"{osrm_url}/route/v1/driving/"
        f"{pickup_lng},{pickup_lat};{dropoff_lng},{dropoff_lat}"
        f"?overview=false"
    )

    try:
        response = httpx.get(url, timeout=timeout_seconds)
    except httpx.TimeoutException as err:
        return OsrmResult(ok=False, reason="timeout", detail=str(err) or "timed out")
    except httpx.RequestError as err:
        return OsrmResult(ok=False, reason="unreachable", detail=str(err) or "request failed")

    try:
        body = response.json()
    except ValueError:
        if response.is_success:
            return OsrmResult(
                ok=False,
                reason="malformed_response",
                detail="response body was not valid JSON",
            )
        return OsrmResult(
            ok=False, reason="error_status", detail=f"osrm responded {response.status_code}"
        )

    code = body.get("code") if isinstance(body, dict) else None
    if isinstance(code, str) and code != "Ok":
        message = body.get("message") if isinstance(body, dict) else None
        detail = message if isinstance(message, str) else f"osrm code={code}"
        return OsrmResult(ok=False, reason="no_route", detail=detail)

    if not response.is_success:
        return OsrmResult(
            ok=False, reason="error_status", detail=f"osrm responded {response.status_code}"
        )

    route = _parse_route(body)
    if route is None:
        return OsrmResult(
            ok=False,
            reason="malformed_response",
            detail=f"unexpected response shape: {body}",
        )

    return OsrmResult(ok=True, route=route)


def _parse_route(body: Any) -> OsrmRoute | None:
    if not isinstance(body, dict):
        return None
    routes = body.get("routes")
    if not isinstance(routes, list) or len(routes) == 0:
        return None
    first = routes[0]
    if not isinstance(first, dict):
        return None

    distance = first.get("distance")
    duration = first.get("duration")
    if not isinstance(distance, int | float) or isinstance(distance, bool) or distance < 0:
        return None
    if not isinstance(duration, int | float) or isinstance(duration, bool) or duration < 0:
        return None

    return OsrmRoute(distance_meters=float(distance), duration_seconds=float(duration))
