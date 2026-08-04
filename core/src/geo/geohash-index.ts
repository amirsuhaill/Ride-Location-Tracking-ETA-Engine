import { cellOf, cellHash, type GridCell, type LatLng, bitSplit, MAX_BITS } from "./geohash";
import { haversineDistanceMeters } from "../services/haversine";

const METERS_PER_DEGREE_LAT = 111_320;

export interface GeoIndexEntry {
  id: string;
  lat: number;
  lng: number;
  distanceMeters: number;
}

export interface GeohashIndexOptions {
  /**
   * Fixed bit precision for every bucket in this index — chosen once, at construction, to match
   * this system's actual typical query radius (see docs/custom-geo-index.md: our real workload
   * essentially always searches around one fixed radius, `MATCH_SEARCH_RADIUS_METERS`, so a
   * single-precision bucket index is an honest fit for the access pattern rather than a generic
   * arbitrary-radius structure — Redis's sorted-set approach doesn't need this tradeoff, which is
   * one of the places it's a more general solution than this one).
   */
  bucketBits: number;
}

/**
 * A from-scratch geohash-bucket spatial index (Phase 12, docs/custom-geo-index.md) — the
 * conceptual technique behind Redis's own GEO commands (bucket points into geohash cells, scan
 * the query cell's neighborhood, filter candidates by exact distance), implemented with a plain
 * `Map` of buckets rather than Redis's sorted-skip-list-by-integer-score, trading arbitrary-radius
 * flexibility for O(1) inserts/updates and a simpler implementation — see the design notes in
 * that doc for the reasoning and its limits.
 */
export class GeohashIndex {
  private readonly bucketBits: number;
  private readonly positions = new Map<string, LatLng>();
  private readonly buckets = new Map<bigint, Set<string>>();
  private readonly idToHash = new Map<string, bigint>();

  constructor(options: GeohashIndexOptions) {
    if (options.bucketBits <= 0 || options.bucketBits > MAX_BITS) {
      throw new Error(`bucketBits must be between 1 and ${MAX_BITS}`);
    }
    this.bucketBits = options.bucketBits;
  }

  size(): number {
    return this.positions.size;
  }

  /** O(1) amortized: a hashmap bucket move (delete from the old bucket's Set, add to the new
   * one) if the point crossed a cell boundary, or nothing but a position update if it didn't —
   * no rebalancing, no tree restructuring. This is the concrete answer to "geohash buckets handle
   * frequent updates cheaply" (docs/custom-geo-index.md). */
  upsert(id: string, lat: number, lng: number): void {
    const hash = cellHash(cellOf({ lat, lng }, this.bucketBits), this.bucketBits);
    const oldHash = this.idToHash.get(id);
    if (oldHash !== undefined && oldHash !== hash) {
      this.buckets.get(oldHash)?.delete(id);
    }
    if (oldHash === undefined || oldHash !== hash) {
      let bucket = this.buckets.get(hash);
      if (!bucket) {
        bucket = new Set();
        this.buckets.set(hash, bucket);
      }
      bucket.add(id);
      this.idToHash.set(id, hash);
    }
    this.positions.set(id, { lat, lng });
  }

  remove(id: string): void {
    const hash = this.idToHash.get(id);
    if (hash === undefined) return;
    const bucket = this.buckets.get(hash);
    bucket?.delete(id);
    if (bucket && bucket.size === 0) this.buckets.delete(hash);
    this.idToHash.delete(id);
    this.positions.delete(id);
  }

  /** Cell dimensions (meters) at this index's fixed bucket precision, evaluated at `atLat` since
   * longitude cell width varies with latitude. */
  private cellSizeMeters(atLat: number): { latMeters: number; lngMeters: number } {
    const { latBits, lngBits } = bitSplit(this.bucketBits);
    const cosLat = Math.max(Math.cos((atLat * Math.PI) / 180), 1e-6);
    return {
      latMeters: (180 / 2 ** latBits) * METERS_PER_DEGREE_LAT,
      lngMeters: (360 / 2 ** lngBits) * METERS_PER_DEGREE_LAT * cosLat,
    };
  }

  /**
   * Scans every grid cell within `ringCount` cells of `center`'s own cell (a
   * (2*ringCount+1)-square block) and returns the union of their buckets — the "check the
   * boundary-adjacent cells too" step. `ringCount` is computed from the requested radius, not
   * fixed at 1, so a radius much larger than this index's fixed cell size still gets a
   * fully-correct (if less efficient) scan rather than silently missing entries.
   */
  private scanCandidates(center: LatLng, ringCount: number): Set<string> {
    const centerCell = cellOf(center, this.bucketBits);
    const { latBits, lngBits } = bitSplit(this.bucketBits);
    const rowCount = 2 ** latBits;
    const colCount = 2 ** lngBits;

    const candidates = new Set<string>();
    for (let dRow = -ringCount; dRow <= ringCount; dRow++) {
      const row = Number(centerCell.row) + dRow;
      if (row < 0 || row >= rowCount) continue; // clamp at the poles, not wrap
      for (let dCol = -ringCount; dCol <= ringCount; dCol++) {
        const col = (((Number(centerCell.col) + dCol) % colCount) + colCount) % colCount; // wrap
        const cell: GridCell = { row: BigInt(row), col: BigInt(col) };
        const hash = cellHash(cell, this.bucketBits);
        const bucket = this.buckets.get(hash);
        if (!bucket) continue;
        for (const id of bucket) candidates.add(id);
      }
    }
    return candidates;
  }

  /** Exhaustive and correct for any radiusMeters (see scanCandidates) — every point actually
   * within radiusMeters of `center` is guaranteed to be found, sorted by exact haversine
   * distance, regardless of whether it sits near this index's internal cell boundaries. */
  radiusSearch(center: LatLng, radiusMeters: number, limit?: number): GeoIndexEntry[] {
    const { latMeters, lngMeters } = this.cellSizeMeters(center.lat);
    const minCellDim = Math.min(latMeters, lngMeters);
    // +1 extra ring: the query point itself can sit anywhere within its own cell (not just the
    // center), so the true search area can extend up to one extra cell-width past a naive
    // radius/cellSize ratio — this is what makes the scan provably exhaustive, not approximate.
    const ringCount = Math.max(1, Math.ceil(radiusMeters / minCellDim) + 1);

    const candidateIds = this.scanCandidates(center, ringCount);
    const results: GeoIndexEntry[] = [];
    for (const id of candidateIds) {
      const pos = this.positions.get(id);
      if (!pos) continue;
      const distanceMeters = haversineDistanceMeters(center, pos);
      if (distanceMeters <= radiusMeters) {
        results.push({ id, lat: pos.lat, lng: pos.lng, distanceMeters });
      }
    }
    results.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return limit === undefined ? results : results.slice(0, limit);
  }

  /**
   * K nearest neighbors via iterative-deepening radius search: start from this index's own cell
   * size as a density-informed initial guess, and double the search radius until at least `k`
   * points are confirmed within it. Because radiusSearch is exhaustive within whatever radius it's
   * given (not an approximation), having >= k confirmed results at some radius R is sufficient to
   * conclude those are the true k nearest overall — nothing closer could be waiting outside R,
   * since everything outside R is by definition farther away than R itself.
   */
  nearestNeighbors(center: LatLng, k: number, maxRadiusMeters = 200_000): GeoIndexEntry[] {
    if (k <= 0) return [];
    const { latMeters, lngMeters } = this.cellSizeMeters(center.lat);
    let radiusMeters = Math.max(50, Math.min(latMeters, lngMeters));

    let results = this.radiusSearch(center, radiusMeters);
    while (results.length < k && radiusMeters < maxRadiusMeters) {
      radiusMeters *= 2;
      results = this.radiusSearch(center, radiusMeters);
    }
    return results.slice(0, k);
  }
}
