import { haversineDistanceMeters, type LatLng } from "../services/haversine";

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface Region {
  id: string;
  /** Separate Redis logical database index (see docs/sharding.md) — a real, addressable
   * separation at the Redis protocol level (distinct connections/keyspaces), not just a
   * key-prefix convention. Deliberately not 0 (or 1), so this never collides with the rest of
   * this project's existing Redis state (drivers:geo, surge:state, etc.), which all live in the
   * default db via src/redis.ts. */
  redisDb: number;
  bbox: BoundingBox;
}

// Two adjacent simulated regions sharing one real boundary (the meridian at -122.386°) rather
// than two disconnected cities — San Francisco (Phase 1's original bounding box, unchanged) and
// an "Oakland/East Bay" region of the same size immediately to its east. A shared border is what
// makes the boundary-query and shard-crossing behavior below actually testable; two cities 500km
// apart would never have a query near "the edge" at all. See docs/sharding.md.
export const REGIONS: Region[] = [
  {
    id: "sf",
    redisDb: 1,
    bbox: { minLat: 37.708, maxLat: 37.812, minLng: -122.514, maxLng: -122.386 },
  },
  {
    id: "oakland",
    redisDb: 2,
    bbox: { minLat: 37.708, maxLat: 37.812, minLng: -122.386, maxLng: -122.258 },
  },
];

/**
 * Which single region owns a point — used for writes (a driver's location must resolve to
 * exactly one shard). Containment is min-inclusive/max-exclusive in longitude for every region
 * except the last (easternmost), which is also max-inclusive, so a point exactly on a shared
 * boundary belongs to exactly one region (the one to its east) and the outer edge of the whole
 * simulated area is still covered rather than being an exclusive dead-end. Returns null for a
 * point outside every simulated region entirely (out of coverage — see docs/sharding.md).
 */
export function regionForPoint(point: LatLng): Region | null {
  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i]!;
    const isEasternmost = i === REGIONS.length - 1;
    const { minLat, maxLat, minLng, maxLng } = region.bbox;

    const latInRange = point.lat >= minLat && point.lat <= maxLat;
    const lngInRange = isEasternmost
      ? point.lng >= minLng && point.lng <= maxLng
      : point.lng >= minLng && point.lng < maxLng;

    if (latInRange && lngInRange) return region;
  }
  return null;
}

/** Haversine distance from `point` to the nearest point inside `bbox` — 0 if `point` is already
 * inside it. Standard axis-aligned-bbox distance: clamp each coordinate independently into the
 * box's range, then measure the distance to that clamped point. */
export function distanceToBboxMeters(point: LatLng, bbox: BoundingBox): number {
  const clampedLat = Math.min(bbox.maxLat, Math.max(bbox.minLat, point.lat));
  const clampedLng = Math.min(bbox.maxLng, Math.max(bbox.minLng, point.lng));
  return haversineDistanceMeters(point, { lat: clampedLat, lng: clampedLng });
}

/**
 * Every region whose bbox is within `radiusMeters` of `point` — used for reads. This is the
 * "boundary-adjacent-cell problem" answer for region sharding (docs/sharding.md): a query near a
 * shared border must check the neighboring region's shard too, not just the one the query point
 * happens to sit in. Naturally includes the point's own region (distance 0) and naturally
 * returns nothing for a point far outside every simulated region — no special-casing needed for
 * either case.
 */
export function regionsWithinRadius(point: LatLng, radiusMeters: number): Region[] {
  return REGIONS.filter((region) => distanceToBboxMeters(point, region.bbox) <= radiusMeters);
}
