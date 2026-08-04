import Redis from "ioredis";
import { config } from "../config";
import { redis as controlPlaneRedis } from "../redis";
import { REGIONS, regionForPoint, regionsWithinRadius, type Region } from "../geo/regions";
import type { LatLng } from "../services/haversine";

// Phase 14 — a real geo-sharded alternative to Phase 3's single-keyspace drivers.geo.repository.ts,
// built and tested standalone rather than wired into the live matching/location-update path (see
// docs/sharding.md's explicit scope note for why, mirroring Phase 12's custom index — this
// module's own correctness, not a production cutover, is what this phase's acceptance criteria
// are about).
//
// Each region gets its own ioredis connection to a distinct Redis logical database (SELECT N) —
// a real, addressable separation at the Redis protocol level, so region "sf" and region
// "oakland" can never accidentally share a key even though every shard uses the identical key
// name internally. Swapping this for genuinely separate Redis *server* instances later is a
// connection-string change (docs/sharding.md), not a routing-logic change.
const GEO_KEY = "drivers:geo";

const shardClients = new Map<string, Redis>(
  REGIONS.map((region) => [region.id, new Redis(config.redisUrl, { db: region.redisDb })]),
);

function shardFor(region: Region): Redis {
  const client = shardClients.get(region.id);
  if (!client) throw new Error(`no Redis shard connection configured for region "${region.id}"`);
  return client;
}

function regionById(regionId: string): Region | undefined {
  return REGIONS.find((r) => r.id === regionId);
}

// Control-plane bookkeeping — "which shard is this driver currently in" — kept in the existing,
// unsharded Redis client (db 0, same as drivers:geo/surge:state/etc. from earlier phases) since
// it's routing metadata, not spatial data itself, and every shard needs to agree on it regardless
// of which shard a given driver happens to be in right now.
const currentRegionKey = (driverId: string): string => `driver-shard-region:${driverId}`;

async function getCurrentRegionId(driverId: string): Promise<string | null> {
  return controlPlaneRedis.get(currentRegionKey(driverId));
}

async function setCurrentRegionId(driverId: string, regionId: string): Promise<void> {
  await controlPlaneRedis.set(currentRegionKey(driverId), regionId);
}

/**
 * Routes a driver's location to the region shard that owns it. If the driver was previously
 * tracked in a *different* region (they've crossed a shared boundary since their last update),
 * their old shard's entry is removed first — this is what keeps a driver from ever existing in
 * two shards' keyspaces at once (docs/sharding.md's "no stale duplicate on crossing" guarantee).
 * Throws if the point is outside every simulated region — there's no shard to route it to.
 */
export async function upsertDriverLocation(
  driverId: string,
  lat: number,
  lng: number,
): Promise<{ regionId: string; migrated: boolean }> {
  const newRegion = regionForPoint({ lat, lng });
  if (!newRegion) {
    throw new Error(
      `(${lat}, ${lng}) is outside every simulated region (${REGIONS.map((r) => r.id).join(", ")}) — no shard to route it to`,
    );
  }

  const previousRegionId = await getCurrentRegionId(driverId);
  const migrated = previousRegionId !== null && previousRegionId !== newRegion.id;

  if (migrated) {
    const previousRegion = regionById(previousRegionId!);
    if (previousRegion) {
      await shardFor(previousRegion).zrem(GEO_KEY, driverId);
    }
  }

  await shardFor(newRegion).geoadd(GEO_KEY, lng, lat, driverId);
  await setCurrentRegionId(driverId, newRegion.id);

  return { regionId: newRegion.id, migrated };
}

/** Removes a driver from whichever shard they're currently tracked in (e.g. going offline). */
export async function removeDriver(driverId: string): Promise<void> {
  const regionId = await getCurrentRegionId(driverId);
  if (!regionId) return;
  const region = regionById(regionId);
  if (region) await shardFor(region).zrem(GEO_KEY, driverId);
  await controlPlaneRedis.del(currentRegionKey(driverId));
}

export interface ShardedNearbyResult {
  driverId: string;
  distanceMeters: number;
  location: LatLng;
  /** Which region's shard this result actually came from — useful for tests/observability, not
   * needed by a real caller. */
  regionId: string;
}

type RawGeoSearchResult = [string, string, [string, string]];

/**
 * Searches every shard whose region is within `radiusMeters` of `center` (usually just one; two
 * or more near a shared boundary — docs/sharding.md), then merges and re-sorts the combined
 * results by *actual* distance before truncating to `limit`. Deliberately not "concatenate each
 * shard's already-sorted results" — each shard only knows its own results are sorted among
 * themselves, not interleaved correctly with another shard's, so a real merge step is required.
 */
export async function searchNearby(
  center: LatLng,
  radiusMeters: number,
  limit: number,
): Promise<ShardedNearbyResult[]> {
  const candidateRegions = regionsWithinRadius(center, radiusMeters);

  const perRegionResults = await Promise.all(
    candidateRegions.map(async (region) => {
      const raw = (await shardFor(region).geosearch(
        GEO_KEY,
        "FROMLONLAT",
        center.lng,
        center.lat,
        "BYRADIUS",
        radiusMeters,
        "m",
        "ASC",
        "COUNT",
        limit,
        "WITHCOORD",
        "WITHDIST",
      )) as RawGeoSearchResult[];

      return raw.map(([driverId, distanceStr, [lngStr, latStr]]): ShardedNearbyResult => ({
        driverId,
        distanceMeters: Number(distanceStr),
        location: { lat: Number(latStr), lng: Number(lngStr) },
        regionId: region.id,
      }));
    }),
  );

  return perRegionResults
    .flat()
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

/** Direct shard-membership check — used by tests to prove a migrated driver is actually gone
 * from their old shard's sorted set, not just filtered out at query time. */
export async function isDriverInRegionShard(driverId: string, regionId: string): Promise<boolean> {
  const region = regionById(regionId);
  if (!region) throw new Error(`unknown region "${regionId}"`);
  const score = await shardFor(region).zscore(GEO_KEY, driverId);
  return score !== null;
}

/** Total entries currently in one region's shard — used by tests to confirm a removal actually
 * shrank the old shard's keyspace, not just that the specific id is gone. */
export async function getShardMemberCount(regionId: string): Promise<number> {
  const region = regionById(regionId);
  if (!region) throw new Error(`unknown region "${regionId}"`);
  return shardFor(region).zcard(GEO_KEY);
}

export async function resetShardedRegionsForTests(): Promise<void> {
  await Promise.all(REGIONS.map((region) => shardFor(region).flushdb()));
}
