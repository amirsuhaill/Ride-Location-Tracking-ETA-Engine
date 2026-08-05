import { config } from "../config";
import type {
  ApiErrorBody,
  ApiErrorCode,
  CreateDriverInput,
  Driver,
  DriverStatus,
  HealthResponse,
  LatLng,
  NearbyDriver,
  Rider,
  SurgePointResponse,
  SurgeZonesResponse,
  Trip,
  TripEta,
} from "./types";

/**
 * Discriminated result — the same reusable typed-fallback pattern core's own external clients use
 * (core/src/services/ml-eta-client.ts, osrm-client.ts): callers need to distinguish "the request
 * itself never reached the server" (offline, DNS failure, connection refused) from "the server
 * responded, just not with 2xx" (a real validation error, a 404, a conflict) — collapsing both
 * into one generic "error" would make it impossible for the UI to show, say, "core is
 * unreachable" vs. "that coordinate is out of range" with different, actionable messages.
 */
export type ApiFailure =
  | { ok: false; reason: "network_error"; detail: string }
  | { ok: false; reason: "api_error"; status: number; code: ApiErrorCode; message: string };

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/** A one-line, user-facing message for any ApiFailure — distinguishes "never reached the
 * server" from the server's own exact validation/error message, rather than collapsing both into
 * one generic string. */
export function describeApiFailure(failure: ApiFailure): string {
  return failure.reason === "network_error"
    ? `Can't reach the server — ${failure.detail}`
    : failure.message;
}

/**
 * A tiny, module-level pub-sub over "is the network actually reaching core right now" —
 * independent of any single hook's own poll interval, since a top-level "you're offline" banner
 * (NetworkStatusBanner.tsx, Frontend Phase 8) needs to react to *any* request failing this way,
 * not just whichever one happens to be polling at the moment. Only `network_error` (the request
 * never reached a server at all — offline, DNS failure, connection refused) flips this; an
 * `api_error` means the request DID reach core, so whatever's wrong is core's/the request's
 * problem, not connectivity, and must not be conflated with it here.
 *
 * `UNHEALTHY_AFTER` requires more than one consecutive failure before declaring "unreachable" — a
 * single dropped request (a genuinely transient blip) firing a whole-app banner would be noisier
 * than useful; two in a row is a much stronger signal something's actually down.
 */
const UNHEALTHY_AFTER = 2;
let consecutiveNetworkFailures = 0;
let lastReportedHealthy = true;
const networkHealthListeners = new Set<(healthy: boolean) => void>();

function reportNetworkOutcome(reachedServer: boolean): void {
  consecutiveNetworkFailures = reachedServer ? 0 : consecutiveNetworkFailures + 1;
  const healthy = consecutiveNetworkFailures < UNHEALTHY_AFTER;
  if (healthy === lastReportedHealthy) return;
  lastReportedHealthy = healthy;
  for (const listener of networkHealthListeners) listener(healthy);
}

/** Subscribes to "can core actually be reached right now" — returns an unsubscribe function.
 * Fires only on a real transition (healthy -> unhealthy or back), not on every request. */
export function onNetworkHealthChange(listener: (healthy: boolean) => void): () => void {
  networkHealthListeners.add(listener);
  return () => networkHealthListeners.delete(listener);
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${config.coreApiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    reportNetworkOutcome(false);
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "network_error", detail };
  }

  reportNetworkOutcome(true); // reached a server at all — a 4xx/5xx is not a connectivity problem

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body (shouldn't happen against core, but don't crash on it) — fall
      // through to the generic message below instead.
    }
    return {
      ok: false,
      reason: "api_error",
      status: response.status,
      code: body?.error.code ?? "INTERNAL_ERROR",
      message: body?.error.message ?? `Request failed with status ${response.status}`,
    };
  }

  const data = (await response.json()) as T;
  return { ok: true, data };
}

export function getHealth(): Promise<ApiResult<HealthResponse>> {
  return request<HealthResponse>("/health");
}

export function createDriver(input: CreateDriverInput): Promise<ApiResult<Driver>> {
  return request<Driver>("/drivers", { method: "POST", body: JSON.stringify(input) });
}

export function getDriver(id: string): Promise<ApiResult<Driver>> {
  return request<Driver>(`/drivers/${id}`);
}

export function patchDriverStatus(id: string, status: DriverStatus): Promise<ApiResult<Driver>> {
  return request<Driver>(`/drivers/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function patchDriverLocation(id: string, location: LatLng): Promise<ApiResult<Driver>> {
  return request<Driver>(`/drivers/${id}/location`, {
    method: "PATCH",
    body: JSON.stringify(location),
  });
}

export interface NearbyDriversQuery extends LatLng {
  radius?: number;
  limit?: number;
}

export function getNearbyDrivers(
  query: NearbyDriversQuery,
): Promise<ApiResult<{ drivers: NearbyDriver[] }>> {
  const params = new URLSearchParams({ lat: String(query.lat), lng: String(query.lng) });
  if (query.radius !== undefined) params.set("radius", String(query.radius));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return request<{ drivers: NearbyDriver[] }>(`/drivers/nearby?${params.toString()}`);
}

export function createRider(name: string): Promise<ApiResult<Rider>> {
  return request<Rider>("/riders", { method: "POST", body: JSON.stringify({ name }) });
}

export function getRider(id: string): Promise<ApiResult<Rider>> {
  return request<Rider>(`/riders/${id}`);
}

export interface CreateTripInput {
  riderId: string;
  pickup: LatLng;
  dropoff: LatLng;
}

export function createTrip(input: CreateTripInput): Promise<ApiResult<Trip>> {
  return request<Trip>("/trips", { method: "POST", body: JSON.stringify(input) });
}

export function getTrip(id: string): Promise<ApiResult<Trip>> {
  return request<Trip>(`/trips/${id}`);
}

export function getTripEta(id: string): Promise<ApiResult<TripEta>> {
  return request<TripEta>(`/trips/${id}/eta`);
}

export function getSurgeZones(): Promise<ApiResult<SurgeZonesResponse>> {
  return request<SurgeZonesResponse>("/surge");
}

export function getSurgeAtPoint(point: LatLng): Promise<ApiResult<SurgePointResponse>> {
  const params = new URLSearchParams({ lat: String(point.lat), lng: String(point.lng) });
  return request<SurgePointResponse>(`/surge?${params.toString()}`);
}
