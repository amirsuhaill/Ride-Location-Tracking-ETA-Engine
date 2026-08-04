import { redis } from "../redis";

// ETA is derived/live data (recomputed from wherever the driver currently is), not durable
// source-of-truth state — same durable-vs-live split as docs/redis-geo.md, so it lives in Redis
// rather than as new Postgres columns on `trips`.
const etaKey = (tripId: string): string => `trip:${tripId}:eta`;

// Safety-net expiry so an abandoned/never-completed trip's cached ETA doesn't linger in Redis
// forever — cheap insurance, not load-bearing for correctness (trips reaching a terminal status
// simply stop being recomputed).
const CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Which engine actually produced a given cached ETA (Phase 10, docs/eta-integration.md) — kept
 * alongside the number itself so a later read can report where it came from, not just what it
 * is. "ml_fallback" is distinct from "heuristic" even though both use the same formula: it
 * records that ml-service was attempted first and failed, which matters for observability even
 * though the resulting number is computed identically to plain heuristic mode. "heuristic_osrm"
 * (Phase 15, docs/osrm-routing.md) means a real OSRM road-network route was used instead of
 * straight-line haversine distance — "heuristic" alone now specifically means the haversine
 * calculation, whether because OSRM is disabled or because it was tried and failed. */
export type EtaSource = "heuristic" | "ml" | "ml_fallback" | "heuristic_osrm";

export interface CachedEta {
  etaSeconds: number;
  distanceMeters: number;
  /** Epoch ms this ETA was computed at, and the driver position it was computed from — used to
   * evaluate the throttled-recompute thresholds (see docs/eta.md). */
  computedAtMs: number;
  computedAtLat: number;
  computedAtLng: number;
  source: EtaSource;
}

export async function getCachedEta(tripId: string): Promise<CachedEta | null> {
  const raw = await redis.hgetall(etaKey(tripId));
  if (!raw.etaSeconds) return null;
  return {
    etaSeconds: Number(raw.etaSeconds),
    distanceMeters: Number(raw.distanceMeters),
    computedAtMs: Number(raw.computedAtMs),
    computedAtLat: Number(raw.computedAtLat),
    computedAtLng: Number(raw.computedAtLng),
    // Cached values written before Phase 10 have no `source` field — default to "heuristic"
    // (the only engine that existed then) rather than leaving it undefined.
    source: (raw.source as EtaSource | undefined) ?? "heuristic",
  };
}

export async function setCachedEta(tripId: string, eta: CachedEta): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.hset(etaKey(tripId), {
    etaSeconds: eta.etaSeconds,
    distanceMeters: eta.distanceMeters,
    computedAtMs: eta.computedAtMs,
    computedAtLat: eta.computedAtLat,
    computedAtLng: eta.computedAtLng,
    source: eta.source,
  });
  pipeline.expire(etaKey(tripId), CACHE_TTL_SECONDS);
  await pipeline.exec();
}
