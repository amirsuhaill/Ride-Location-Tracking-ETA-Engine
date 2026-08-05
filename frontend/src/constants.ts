/**
 * Mirrors SF_BBOX from core/scripts/seed.ts and core/scripts/lib/trip-simulator.ts exactly — the
 * same simulated-city bounding box used throughout the backend (seeded drivers, the historical
 * trip simulator, the OSRM road-network extract). Reused here rather than approximated so the
 * map's initial view lines up with where the backend's own data actually is.
 */
export const SF_BBOX = {
  minLat: 37.708,
  maxLat: 37.812,
  minLng: -122.514,
  maxLng: -122.386,
};

/**
 * Mirrors NEARBY_MAX_RADIUS_METERS from core/src/schemas/drivers.ts — core rejects (not clamps)
 * a GET /drivers/nearby request above this radius, so the frontend clamps its own
 * viewport-derived radius before ever sending it, rather than surfacing a validation error to
 * the user just for zooming out far enough.
 */
export const NEARBY_MAX_RADIUS_METERS = 50_000;

/**
 * Mirrors core's surge config defaults (core/src/config.ts, docs/surge-pricing.md) — also
 * hardcoded (not `${VAR:-default}`) in infra/docker-compose.yml, so a host env override is
 * silently ignored there too; these are the real values the packaged stack actually runs with,
 * not just this project's documented defaults. `GET /surge` returns each zone's `center` but not
 * its radius, so the frontend needs its own copy of SURGE_ZONE_RADIUS_METERS to draw the right
 * size circle — there's no API that returns zone geometry directly (see docs/surge-pricing.md:
 * a zone's radius is what *defines* the geohash precision server-side, not a per-zone response
 * field).
 */
export const SURGE_ZONE_RADIUS_METERS = 2_000;
export const SURGE_MIN_MULTIPLIER = 1.0;
export const SURGE_MAX_MULTIPLIER = 3.0;

/**
 * Mirrors SURGE_UPDATE_INTERVAL_MS's default — surge is recomputed server-side on this fixed
 * interval, never per-request (docs/surge-pricing.md), so polling faster only wastes requests on
 * a number that hasn't changed. Matching the real interval exactly (not just "same order of
 * magnitude" loosely) means the UI reflects a fresh value as soon as one actually exists, with no
 * avoidable extra staleness on top of the server's own recompute cadence.
 */
export const SURGE_UPDATE_INTERVAL_MS = 15_000;

/**
 * Real geographic bounds — every one of core's own lat/lng Zod schemas (e.g.
 * core/src/schemas/surge.ts's `surgeQuerySchema`, core/src/schemas/drivers.ts) rejects values
 * outside these with a 400 VALIDATION_ERROR. Mirrored here so `CoordinateEntryForm` (Frontend
 * Phase 7/8) can reject an out-of-range value immediately, client-side, with zero network
 * round-trip — a real "the person needs to fix this input" case, never something worth quietly
 * retrying (docs/frontend-resilience.md).
 */
export const LAT_MIN = -90;
export const LAT_MAX = 90;
export const LNG_MIN = -180;
export const LNG_MAX = 180;
