import * as tripsRepo from "../repositories/trips.repository";
import type { Trip } from "../repositories/trips.repository";
import * as driversRepo from "../repositories/drivers.repository";
import * as etaRepo from "../repositories/eta.repository";
import type { CachedEta, EtaSource } from "../repositories/eta.repository";
import { haversineDistanceMeters, type LatLng } from "./haversine";
import { estimateEta, getRushHourMultiplier, type EtaEstimate } from "./eta-heuristic";
import { getEtaConfig, type EtaRuntimeConfig } from "./eta-config";
import { fetchMlEta } from "./ml-eta-client";
import { fetchOsrmRoute } from "./osrm-client";
import { NotFoundError } from "../errors";
import { logger } from "../logger";

export type EtaStatus =
  | "ok"
  | "no_driver_assigned"
  | "trip_completed"
  | "trip_cancelled"
  | "stale_location"
  | "ml_unavailable";

export interface EtaResult {
  tripId: string;
  status: EtaStatus;
  etaSeconds: number | null;
  distanceMeters: number | null;
  /** When this ETA figure was actually computed (ISO), or null if none has ever been computed. */
  computedAt: string | null;
  /** How old the driver's last known location is, in ms — null if there's no driver/location at
   * all to measure. Always present (even in the "ok" case) for transparency. */
  driverLocationAgeMs: number | null;
  /** Which engine produced the current number — heuristic | ml | ml_fallback — or null if no
   * ETA has ever been computed for this trip. See docs/eta-integration.md. */
  etaSource: EtaSource | null;
  /** true if this response reused an already-cached value (the throttle said it wasn't time to
   * recompute yet, or — mode "ml" only — a fresh ML attempt failed with nothing to fall back to
   * but the prior cache); false if this call triggered a brand new computation. Null alongside
   * etaSource === null (nothing has ever been computed). */
  servedFromCache: boolean | null;
}

function fromCached(
  tripId: string,
  status: EtaStatus,
  cached: CachedEta | null,
  driverLocationAgeMs: number | null,
  servedFromCache: boolean | null = cached !== null,
): EtaResult {
  return {
    tripId,
    status,
    etaSeconds: cached?.etaSeconds ?? null,
    distanceMeters: cached?.distanceMeters ?? null,
    computedAt: cached ? new Date(cached.computedAtMs).toISOString() : null,
    driverLocationAgeMs,
    etaSource: cached?.source ?? null,
    servedFromCache,
  };
}

function buildCachedEta(
  estimate: EtaEstimate,
  nowMs: number,
  driverLocation: LatLng,
  source: EtaSource,
): CachedEta {
  return {
    etaSeconds: estimate.etaSeconds,
    distanceMeters: estimate.distanceMeters,
    computedAtMs: nowMs,
    computedAtLat: driverLocation.lat,
    computedAtLng: driverLocation.lng,
    source,
  };
}

/**
 * The "heuristic" computation itself (Phase 15, docs/osrm-routing.md): when OSRM is enabled,
 * tries a real road-network route first — same reusable typed-fallback pattern as the ML path
 * below (fetchOsrmRoute mirrors fetchMlEta) — and only falls back to straight-line haversine
 * (estimateEta) if OSRM is disabled or the attempt fails for any reason. OSRM's own duration is a
 * free-flow estimate with no traffic model of its own, so the same rush-hour multiplier used by
 * the haversine heuristic is still layered on top, exactly as it would be for a plain haversine
 * estimate. Shared by both the "heuristic" mode and "ml_with_fallback"'s fallback branch, so
 * enabling OSRM improves every path that ultimately falls back to the heuristic, not just one.
 */
async function computeHeuristicEta(
  tripId: string,
  driverLocation: LatLng,
  target: LatLng,
  nowMs: number,
  cfg: EtaRuntimeConfig,
): Promise<CachedEta> {
  if (cfg.osrmEnabled) {
    const osrmResult = await fetchOsrmRoute(driverLocation, target, {
      osrmUrl: cfg.osrmUrl,
      timeoutMs: cfg.osrmTimeoutMs,
    });

    if (osrmResult.ok) {
      const multiplier = getRushHourMultiplier(new Date(nowMs));
      const estimate: EtaEstimate = {
        etaSeconds: osrmResult.route.durationSeconds * multiplier,
        distanceMeters: osrmResult.route.distanceMeters,
      };
      return buildCachedEta(estimate, nowMs, driverLocation, "heuristic_osrm");
    }

    logger.warn(
      { tripId, reason: osrmResult.reason, detail: osrmResult.detail },
      "osrm route failed — falling back to haversine heuristic",
    );
  }

  const estimate = estimateEta(driverLocation, target, new Date(nowMs), cfg);
  return buildCachedEta(estimate, nowMs, driverLocation, "heuristic");
}

interface EngineOutcome {
  /** null only in mode "ml" when a fresh attempt failed and there was nothing cached to fall
   * back to at all. */
  eta: CachedEta | null;
  /** Whether `eta` is a brand new computation that should be persisted to the cache. */
  fresh: boolean;
  /** true iff mode was "ml" (no fallback) and this call's ML attempt failed — surfaced by
   * getTripEta as a distinct "ml_unavailable" status, regardless of whether a stale cached
   * value still exists to show alongside it. Always false for "heuristic" and
   * "ml_with_fallback" (a successful fallback is a full, if different-sourced, success). */
  mlUnavailable: boolean;
}

/**
 * Dispatches to whichever engine `cfg.mode` selects (see config.ts's EtaMode doc comment) —
 * heuristic-only, ML-only (no fallback — failures are surfaced, not masked), or ML with a
 * heuristic fallback. Failures are logged (the shared structured logger, src/logger.ts — same
 * convention as reconciliation.service.ts/ws/location-batch.ts for non-request-context service
 * code) since that's the actionable event; successful responses are already observable via the
 * etaSource/servedFromCache fields and the X-ETA-* response headers on every call, so logging
 * every success too would just be noise.
 */
async function computeEtaForMode(
  mode: EtaRuntimeConfig["mode"],
  tripId: string,
  driverLocation: LatLng,
  target: LatLng,
  nowMs: number,
  cfg: EtaRuntimeConfig,
  priorCached: CachedEta | null,
): Promise<EngineOutcome> {
  if (mode === "heuristic") {
    return {
      eta: await computeHeuristicEta(tripId, driverLocation, target, nowMs, cfg),
      fresh: true,
      mlUnavailable: false,
    };
  }

  const mlResult = await fetchMlEta(driverLocation, target, new Date(nowMs), {
    mlServiceUrl: cfg.mlServiceUrl,
    timeoutMs: cfg.mlTimeoutMs,
  });

  if (mlResult.ok) {
    const estimate: EtaEstimate = {
      etaSeconds: mlResult.prediction.etaSeconds,
      distanceMeters: mlResult.prediction.distanceMeters,
    };
    return {
      eta: buildCachedEta(estimate, nowMs, driverLocation, "ml"),
      fresh: true,
      mlUnavailable: false,
    };
  }

  if (mode === "ml_with_fallback") {
    logger.warn(
      { tripId, reason: mlResult.reason, detail: mlResult.detail },
      "ml-service predict-eta failed — falling back to heuristic",
    );
    const fallbackEta = await computeHeuristicEta(tripId, driverLocation, target, nowMs, cfg);
    return {
      eta: { ...fallbackEta, source: "ml_fallback" },
      fresh: true,
      mlUnavailable: false,
    };
  }

  // mode === "ml", no fallback configured: surface the failure rather than mask it.
  logger.warn(
    { tripId, reason: mlResult.reason, detail: mlResult.detail },
    "ml-service predict-eta failed — no fallback configured (mode=ml)",
  );
  return { eta: priorCached, fresh: false, mlUnavailable: true };
}

/**
 * Recomputes and caches the ETA for `trip` given the driver's current position, but only if the
 * throttle thresholds say it's actually time to — otherwise returns the existing cached value
 * untouched. Shared by both the "a driver's location just updated" hook and `getTripEta` (a GET
 * request opportunistically triggers the same throttled check, so the endpoint is never stuck
 * showing a missing value it could reasonably have computed). See docs/eta.md and, for the
 * ML-integration behavior, docs/eta-integration.md.
 */
async function maybeRecomputeEta(
  trip: Trip,
  driverLocation: LatLng,
  nowMs: number,
): Promise<{ eta: CachedEta | null; servedFromCache: boolean; mlUnavailable: boolean }> {
  const cached = await etaRepo.getCachedEta(trip.id);
  const cfg = getEtaConfig();

  // The heuristic is a free local calculation; an ML call is a network hop worth protecting
  // ml-service from being hammered by rapid location updates — same throttle mechanism
  // (time-elapsed OR distance-moved, whichever first), just a mode-dependent time threshold.
  // See config.ts's etaMlCacheTtlMs doc comment.
  const recomputeIntervalMs = cfg.mode === "heuristic" ? cfg.recomputeIntervalMs : cfg.mlCacheTtlMs;

  const timeSinceLastComputeMs = cached ? nowMs - cached.computedAtMs : Infinity;
  const distanceSinceLastComputeMeters = cached
    ? haversineDistanceMeters(driverLocation, {
        lat: cached.computedAtLat,
        lng: cached.computedAtLng,
      })
    : Infinity;

  const shouldRecompute =
    !cached ||
    timeSinceLastComputeMs >= recomputeIntervalMs ||
    distanceSinceLastComputeMeters >= cfg.recomputeDistanceMeters;

  if (!shouldRecompute) {
    return { eta: cached, servedFromCache: true, mlUnavailable: false };
  }

  // In progress (driver has the rider onboard) targets the dropoff; otherwise (matched, not yet
  // picked up) targets the pickup — two different legs of the same trip.
  const target = trip.status === "in_progress" ? trip.dropoff : trip.pickup;
  const outcome = await computeEtaForMode(
    cfg.mode,
    trip.id,
    driverLocation,
    target,
    nowMs,
    cfg,
    cached,
  );

  if (outcome.fresh && outcome.eta) {
    await etaRepo.setCachedEta(trip.id, outcome.eta);
  }
  return {
    eta: outcome.eta,
    servedFromCache: !outcome.fresh,
    mlUnavailable: outcome.mlUnavailable,
  };
}

/** Called for a single driver location update — a no-op unless this driver currently has an
 * active (matched/in_progress) trip. Kept for callers with exactly one update to process (e.g.
 * test/eta.service.test.ts's direct throttle tests); the fleet-wide flush path
 * (ws/location-batch.ts) uses handleDriverLocationUpdatesBatch below instead, which does the
 * same thing but without the one-Postgres-query-per-driver cost this function has on its own —
 * see docs/load-testing.md. */
export async function handleDriverLocationUpdate(
  driverId: string,
  lat: number,
  lng: number,
  timestampMs: number,
): Promise<void> {
  const trip = await tripsRepo.findActiveTripForDriver(driverId);
  if (!trip) return;
  await maybeRecomputeEta(trip, { lat, lng }, timestampMs);
}

export interface BatchLocationUpdate {
  driverId: string;
  lat: number;
  lng: number;
  timestampMs: number;
}

/**
 * Batched equivalent of calling handleDriverLocationUpdate once per update — looks up every
 * driver's active trip (if any) in a single query, then recomputes ETA only for the ones that
 * actually have one. Introduced in Phase 11 specifically to fix the connection-pool exhaustion
 * documented in docs/load-testing.md: the per-driver version made one Postgres query per driver
 * on every batch flush regardless of whether that driver had an active trip at all, which at
 * fleet scale saturated the pool (default max 10 connections) and backed up the whole batch
 * window.
 */
export async function handleDriverLocationUpdatesBatch(
  updates: BatchLocationUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  const driverIds = updates.map((u) => u.driverId);
  const tripsByDriverId = await tripsRepo.findActiveTripsForDrivers(driverIds);
  if (tripsByDriverId.size === 0) return;

  await Promise.all(
    updates.map(async (update) => {
      const trip = tripsByDriverId.get(update.driverId);
      if (!trip) return;
      await maybeRecomputeEta(trip, { lat: update.lat, lng: update.lng }, update.timestampMs);
    }),
  );
}

export async function getTripEta(tripId: string): Promise<EtaResult> {
  const trip = await tripsRepo.findTripById(tripId);
  if (!trip) throw new NotFoundError(`Trip ${tripId} not found`);

  // A completed trip has definitionally arrived — 0, not a stale leftover number.
  if (trip.status === "completed") {
    return {
      tripId,
      status: "trip_completed",
      etaSeconds: 0,
      distanceMeters: 0,
      computedAt: null,
      driverLocationAgeMs: null,
      etaSource: null,
      servedFromCache: null,
    };
  }

  // A cancelled trip has no meaningful ETA at all — not even 0, since it was never completed.
  if (trip.status === "cancelled") {
    return {
      tripId,
      status: "trip_cancelled",
      etaSeconds: null,
      distanceMeters: null,
      computedAt: null,
      driverLocationAgeMs: null,
      etaSource: null,
      servedFromCache: null,
    };
  }

  // "requested" (or, defensively, any other status with no driver_id yet): ETA doesn't mean
  // anything before a driver exists to be en route.
  if (!trip.driverId) {
    return {
      tripId,
      status: "no_driver_assigned",
      etaSeconds: null,
      distanceMeters: null,
      computedAt: null,
      driverLocationAgeMs: null,
      etaSource: null,
      servedFromCache: null,
    };
  }

  const driver = await driversRepo.findDriverById(trip.driverId);
  const now = Date.now();
  const cfg = getEtaConfig();

  // No driver row (shouldn't happen) or no location ever reported yet — can't compute an ETA at
  // all, but degrade gracefully to whatever was last cached (usually nothing, in this case)
  // rather than crashing or fabricating a number.
  if (!driver || !driver.location) {
    const cached = await etaRepo.getCachedEta(tripId);
    return fromCached(tripId, "stale_location", cached, null);
  }

  const driverLocationAgeMs = now - driver.lastUpdatedAt.getTime();
  if (driverLocationAgeMs > cfg.staleLocationMs) {
    // Explicitly flagged, not silently returned as if it were current — the caller decides
    // whether a stale-but-present number is still useful to show.
    const cached = await etaRepo.getCachedEta(tripId);
    return fromCached(tripId, "stale_location", cached, driverLocationAgeMs);
  }

  const result = await maybeRecomputeEta(trip, driver.location, now);
  const status: EtaStatus = result.mlUnavailable ? "ml_unavailable" : "ok";
  return fromCached(tripId, status, result.eta, driverLocationAgeMs, result.servedFromCache);
}
