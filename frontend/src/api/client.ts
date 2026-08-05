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
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "network_error"; detail: string }
  | { ok: false; reason: "api_error"; status: number; code: ApiErrorCode; message: string };

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${config.coreApiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "network_error", detail };
  }

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
