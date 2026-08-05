/**
 * Types mirroring the real shapes core actually returns (docs/API.md) and the real Zod input
 * schemas in core/src/schemas/*.ts — not invented independently. If core's schemas change, these
 * need a matching update; that's a real, accepted cost of the frontend/backend being separate
 * codebases (same tradeoff ml-service/app/ml/constants.ts documents for its own TS-mirroring).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

// Mirrors core/src/schemas/drivers.ts's DRIVER_STATUSES.
export const DRIVER_STATUSES = ["online", "offline", "busy"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export interface Driver {
  id: string;
  name: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  vehiclePlate: string;
  status: DriverStatus;
  location: LatLng | null;
  lastUpdatedAt: string;
  createdAt: string;
}

export interface CreateDriverInput {
  name: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  vehiclePlate: string;
  status?: DriverStatus;
  location?: LatLng;
}

export interface NearbyDriver {
  driverId: string;
  distanceMeters: number;
  location: LatLng;
}

export interface Rider {
  id: string;
  name: string;
  createdAt: string;
}

// Mirrors core/src/schemas/trips.ts's TRIP_STATUSES.
export const TRIP_STATUSES = [
  "requested",
  "matched",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export type CancellationReason = "no_drivers_available" | "all_candidates_declined" | null;

export interface FareEstimate {
  currency: string;
  baseCents: number;
  distanceCents: number;
  timeCents: number;
  subtotalCents: number;
  surgeMultiplier: number;
  totalCents: number;
}

export interface Trip {
  id: string;
  riderId: string;
  driverId: string | null;
  status: TripStatus;
  pickup: LatLng;
  dropoff: LatLng;
  requestedAt: string;
  matchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  cancellationReason: CancellationReason;
  // Only ever present on the POST /trips response — a fresh, unpersisted quote (docs/API.md).
  // A later GET /trips/:id will not include it.
  fareEstimate?: FareEstimate;
}

// Mirrors eta.service.ts's EtaStatus (core/src/services/eta.service.ts).
export type EtaStatus =
  | "ok"
  | "no_driver_assigned"
  | "trip_completed"
  | "trip_cancelled"
  | "stale_location"
  | "ml_unavailable";

// Mirrors eta.repository.ts's EtaSource (core/src/repositories/eta.repository.ts) — null only if
// nothing has ever been computed for this trip.
export type EtaSource = "heuristic" | "heuristic_osrm" | "ml" | "ml_fallback" | null;

export interface TripEta {
  tripId: string;
  status: EtaStatus;
  etaSeconds: number | null;
  distanceMeters: number | null;
  computedAt: string | null;
  driverLocationAgeMs: number | null;
  etaSource: EtaSource;
  servedFromCache: boolean | null;
}

export interface SurgeZone {
  zoneId: string;
  center: LatLng;
  multiplier: number;
  requestCount: number;
  driverCount: number;
  updatedAt: string;
}

export interface SurgeZonesResponse {
  zones: SurgeZone[];
}

export interface SurgePointResponse {
  lat: number;
  lng: number;
  multiplier: number;
}

export interface HealthResponse {
  status: "ok";
  service: string;
  uptime: number;
  version: string;
  build: string;
}

// Mirrors docs/API.md's "Error shape" — the one shape every core error response uses.
export type ApiErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
