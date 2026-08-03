import { redis } from "../redis";
import { config } from "../config";
import type { DriverStatus } from "../schemas/drivers";

// -- Key design --------------------------------------------------------------------------------
// "drivers:geo"        a single Redis Geo sorted set (ZADD under the hood) — one member per
//                      driver, keyed by driver id, scored by a geohash-derived value.
// "driver:{id}:state"  a hash holding the two bits of state a nearby-search needs beyond
//                      position: status and lastUpdatedAtMs (epoch ms of the last write). Kept
//                      separate from the geo set because Redis has no per-member TTL/metadata on
//                      sorted set entries — only whole-key TTLs — so "is this driver's *entry*
//                      stale" has to be tracked in its own key. See docs/redis-geo.md.
const GEO_KEY = "drivers:geo";
const stateKey = (driverId: string): string => `driver:${driverId}:state`;

// Over-fetch from Redis before filtering by status/freshness in JS, so that a radius full of
// busy/offline/stale drivers doesn't silently under-fill `limit`. Capped so a tiny limit doesn't
// still force scanning a huge candidate set.
const OVER_FETCH_FACTOR = 5;
const MAX_CANDIDATES = 500;

export interface NearbyDriver {
  driverId: string;
  distanceMeters: number;
  location: { lat: number; lng: number };
  /** When this driver most recently became "online" (epoch ms), or null if never explicitly
   * tracked — see docs/matching.md for how this feeds the idle-time scoring signal. */
  onlineSinceMs: number | null;
}

export async function upsertDriverLocation(
  driverId: string,
  lat: number,
  lng: number,
  status: DriverStatus,
): Promise<void> {
  const now = Date.now();
  // A pipeline, not a MULTI/EXEC transaction — see docs/redis-geo.md for why full atomicity
  // isn't needed for this pair of writes.
  const pipeline = redis.pipeline();
  pipeline.geoadd(GEO_KEY, lng, lat, driverId);
  pipeline.hset(stateKey(driverId), { status, lastUpdatedAtMs: now });
  // HSETNX, not HSET: a routine location ping must never reset onlineSinceMs (that would make
  // idle time always ~0) — this only initializes it the first time a driver's hash is ever
  // created, as a fallback for a driver whose status was already "online" before their first
  // ping (see docs/matching.md). The normal path sets it explicitly on the online transition,
  // in updateDriverStatusInRedis below.
  pipeline.hsetnx(stateKey(driverId), "onlineSinceMs", now);
  await pipeline.exec();
}

export interface BatchGeoEntry {
  driverId: string;
  lat: number;
  lng: number;
  status: DriverStatus;
}

// One pipeline covering an entire batch window's worth of drivers (2N commands, still a single
// round trip via .exec()) instead of N separate two-command pipelines — see
// docs/ws-batching-and-compression.md for the measured savings at fleet scale.
export async function upsertDriverLocationsBatch(entries: BatchGeoEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (const { driverId, lat, lng, status } of entries) {
    pipeline.geoadd(GEO_KEY, lng, lat, driverId);
    pipeline.hset(stateKey(driverId), { status, lastUpdatedAtMs: now });
    pipeline.hsetnx(stateKey(driverId), "onlineSinceMs", now);
  }
  await pipeline.exec();
}

export async function updateDriverStatusInRedis(
  driverId: string,
  status: DriverStatus,
): Promise<void> {
  const now = Date.now();
  const pipeline = redis.pipeline();
  const hashUpdate: Record<string, string | number> = { status, lastUpdatedAtMs: now };
  if (status === "online") {
    // A fresh idle-time clock every time a driver becomes available — including cycling
    // busy -> online after finishing a trip, which correctly represents "just became available
    // again," not their original online timestamp from hours ago.
    hashUpdate.onlineSinceMs = now;
  }
  pipeline.hset(stateKey(driverId), hashUpdate);
  if (status === "offline") {
    // Immediate removal on an explicit "offline" — no need to wait for the reconciliation job
    // to notice staleness when we already know for certain.
    pipeline.zrem(GEO_KEY, driverId);
  }
  await pipeline.exec();
}

interface DriverState {
  status: DriverStatus;
  lastUpdatedAtMs: number;
  onlineSinceMs: number | null;
}

export async function getDriverState(driverId: string): Promise<DriverState | null> {
  const raw = await redis.hgetall(stateKey(driverId));
  if (!raw.status || !raw.lastUpdatedAtMs) return null;
  return {
    status: raw.status as DriverStatus,
    lastUpdatedAtMs: Number(raw.lastUpdatedAtMs),
    onlineSinceMs: raw.onlineSinceMs ? Number(raw.onlineSinceMs) : null,
  };
}

function isFresh(state: DriverState, nowMs: number): boolean {
  return nowMs - state.lastUpdatedAtMs <= config.driverStaleMs;
}

export async function searchNearby(
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number,
): Promise<NearbyDriver[]> {
  const candidateCount = Math.min(limit * OVER_FETCH_FACTOR, MAX_CANDIDATES);

  const raw = (await redis.geosearch(
    GEO_KEY,
    "FROMLONLAT",
    lng,
    lat,
    "BYRADIUS",
    radiusMeters,
    "m",
    "ASC",
    "COUNT",
    candidateCount,
    "WITHCOORD",
    "WITHDIST",
  )) as [string, string, [string, string]][];

  if (raw.length === 0) return [];

  const now = Date.now();
  const states = await Promise.all(raw.map(([driverId]) => getDriverState(driverId)));

  const results: NearbyDriver[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const state = states[i];
    if (!entry || !state) continue;
    if (state.status !== "online") continue;
    if (!isFresh(state, now)) continue;

    const [driverId, distanceStr, [lngStr, latStr]] = entry;
    results.push({
      driverId,
      distanceMeters: Number(distanceStr),
      location: { lat: Number(latStr), lng: Number(lngStr) },
      onlineSinceMs: state.onlineSinceMs,
    });
    if (results.length >= limit) break;
  }

  return results;
}

// -- Background reconciliation ------------------------------------------------------------------
// Uses SCAN (cursor-based, non-blocking), not KEYS — KEYS is O(n) and blocks the single-threaded
// Redis event loop for the entire keyspace scan, which would stall every other client's commands
// on a busy instance. SCAN does the same O(n) total work but in small non-blocking increments.
export interface StaleDriver {
  driverId: string;
  lastStatus: DriverStatus;
}

export async function findStaleDrivers(nowMs: number): Promise<StaleDriver[]> {
  const stale: StaleDriver[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "driver:*:state", "COUNT", 200);
    cursor = nextCursor;
    for (const key of keys) {
      const driverId = key.split(":")[1];
      if (!driverId) continue;
      const state = await getDriverState(driverId);
      if (!state) continue;
      if (state.status !== "offline" && !isFresh(state, nowMs)) {
        stale.push({ driverId, lastStatus: state.status });
      }
    }
  } while (cursor !== "0");
  return stale;
}

export async function evictStaleDriver(driverId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.zrem(GEO_KEY, driverId);
  pipeline.hset(stateKey(driverId), { status: "offline", lastUpdatedAtMs: Date.now() });
  await pipeline.exec();
}
