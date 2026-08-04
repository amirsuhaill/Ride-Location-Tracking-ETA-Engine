import type { LatLng } from "./haversine";

export interface OsrmRoute {
  distanceMeters: number;
  durationSeconds: number;
}

export type OsrmFailureReason =
  | "unreachable"
  | "timeout"
  | "no_route"
  | "error_status"
  | "malformed_response";

export type OsrmResult =
  | { ok: true; route: OsrmRoute }
  | { ok: false; reason: OsrmFailureReason; detail: string };

export interface OsrmClientConfig {
  osrmUrl: string;
  timeoutMs: number;
}

/**
 * Calls a real OSRM instance's GET /route/v1/driving (docs/osrm-routing.md) with a hard timeout,
 * returning a discriminated result rather than throwing — same reusable fallback pattern as
 * ml-eta-client.ts's fetchMlEta (Phase 10).
 *
 * One important, verified difference from ml-service's convention: OSRM signals a routing
 * failure (e.g. a point that can't be snapped to any road within its search radius) with HTTP
 * 400 and a JSON body like `{"code":"NoSegment","message":"..."}` — NOT a 200 with an in-body
 * error code. So the body is always parsed as JSON first, regardless of HTTP status, and a
 * recognizable non-"Ok" `code` field is treated as "no_route" before falling back to
 * status-code-based classification for genuinely malformed/unexpected responses.
 */
export async function fetchOsrmRoute(
  from: LatLng,
  to: LatLng,
  cfg: OsrmClientConfig,
): Promise<OsrmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const url =
    `${cfg.osrmUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=false`;

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout", detail: `no response within ${cfg.timeoutMs}ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unreachable", detail: message };
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok
      ? { ok: false, reason: "malformed_response", detail: "response body was not valid JSON" }
      : { ok: false, reason: "error_status", detail: `osrm responded ${response.status}` };
  }

  const code = isRecord(body) ? body.code : undefined;
  if (typeof code === "string" && code !== "Ok") {
    const message = isRecord(body) ? body.message : undefined;
    return {
      ok: false,
      reason: "no_route",
      detail: typeof message === "string" ? message : `osrm code=${code}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: "error_status", detail: `osrm responded ${response.status}` };
  }

  const route = parseRoute(body);
  if (!route) {
    return {
      ok: false,
      reason: "malformed_response",
      detail: `unexpected response shape: ${JSON.stringify(body)}`,
    };
  }

  return { ok: true, route };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRoute(body: unknown): OsrmRoute | null {
  if (!isRecord(body) || !Array.isArray(body.routes) || body.routes.length === 0) return null;
  const first: unknown = body.routes[0];
  if (!isRecord(first)) return null;

  const distanceMeters = first.distance;
  const durationSeconds = first.duration;
  if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return null;
  }
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0
  ) {
    return null;
  }

  return { distanceMeters, durationSeconds };
}
