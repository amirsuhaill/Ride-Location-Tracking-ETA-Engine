/**
 * Bit-interleaved geohash primitives, implemented from scratch (Phase 12, docs/custom-geo-index.md).
 *
 * Standard geohash encoding: repeatedly bisect the lat/lng ranges, alternating dimensions
 * starting with longitude, recording a 1 if the point falls in the upper half of the current
 * range at that step, else 0. This is the same technique geohash.org and Redis's own internal
 * GEO commands use (Redis calls it a "52-bit interleaved integer" — 26 bits per coordinate).
 * `MAX_BITS` here matches that same total.
 *
 * This module works with an explicit (row, col) grid-cell representation as the primary model
 * (a fixed bit precision divides the world into a regular 2^latBits x 2^lngBits grid), with the
 * interleaved bigint hash derived from it — rather than the more common "bit-twiddle the point
 * directly" approach — because GeohashIndex (geohash-index.ts) needs to scan an NxN block of grid
 * cells around a query point for radius search, and row/col arithmetic makes that a plain integer
 * range, not repeated re-encodes.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export const MAX_BITS = 52;
const METERS_PER_DEGREE_LAT = 111_320;

function clampLat(lat: number): number {
  return Math.min(90, Math.max(-90, lat));
}

/** Wraps into [-180, 180) — a driver crossing the antimeridian is a real (if rare) case a
 * from-scratch implementation has to actually handle, not ignore. */
function normalizeLng(lng: number): number {
  let normalized = lng % 360;
  if (normalized < -180) normalized += 360;
  if (normalized >= 180) normalized -= 360;
  return normalized;
}

/** Bit split for a given total precision — longitude gets the first bit (index 0) and therefore
 * one extra bit whenever `bits` is odd, matching the standard lng-first interleaving order. */
export function bitSplit(bits: number): { latBits: number; lngBits: number } {
  return { lngBits: Math.ceil(bits / 2), latBits: Math.floor(bits / 2) };
}

export interface GridCell {
  row: bigint; // latitude index, 0 at the south pole
  col: bigint; // longitude index, 0 at -180°
}

/** Which regular grid cell (at this bit precision) a point falls in. */
export function cellOf(point: LatLng, bits: number): GridCell {
  const { latBits, lngBits } = bitSplit(bits);
  const latSpanDeg = 180 / 2 ** latBits;
  const lngSpanDeg = 360 / 2 ** lngBits;

  const lat = clampLat(point.lat);
  const lng = normalizeLng(point.lng);

  const rowCount = 2 ** latBits;
  const colCount = 2 ** lngBits;
  const row = BigInt(Math.min(rowCount - 1, Math.floor((lat + 90) / latSpanDeg)));
  const col = BigInt(Math.min(colCount - 1, Math.floor((lng + 180) / lngSpanDeg)));
  return { row, col };
}

/** Center + half-width/half-height ("error") of a given grid cell, in degrees. */
export function cellBounds(
  cell: GridCell,
  bits: number,
): { lat: number; lng: number; latErrorDeg: number; lngErrorDeg: number } {
  const { latBits, lngBits } = bitSplit(bits);
  const latSpanDeg = 180 / 2 ** latBits;
  const lngSpanDeg = 360 / 2 ** lngBits;

  const latMin = Number(cell.row) * latSpanDeg - 90;
  const lngMin = Number(cell.col) * lngSpanDeg - 180;
  return {
    lat: latMin + latSpanDeg / 2,
    lng: lngMin + lngSpanDeg / 2,
    latErrorDeg: latSpanDeg / 2,
    lngErrorDeg: lngSpanDeg / 2,
  };
}

/** Interleaves row/col bits into the geohash integer — lng bit, lat bit, lng bit, ... (MSB
 * first), matching the standard convention. */
function interleave(col: bigint, lngBits: number, row: bigint, latBits: number): bigint {
  let result = 0n;
  let colBitsLeft = lngBits;
  let latBitsLeft = latBits;
  const totalBits = lngBits + latBits;
  for (let i = 0; i < totalBits; i++) {
    result <<= 1n;
    if (i % 2 === 0) {
      colBitsLeft--;
      result |= (col >> BigInt(colBitsLeft)) & 1n;
    } else {
      latBitsLeft--;
      result |= (row >> BigInt(latBitsLeft)) & 1n;
    }
  }
  return result;
}

function deinterleave(
  hash: bigint,
  bits: number,
): { row: bigint; col: bigint; latBits: number; lngBits: number } {
  const { latBits, lngBits } = bitSplit(bits);
  let row = 0n;
  let col = 0n;
  for (let i = 0; i < bits; i++) {
    const bitPos = bits - 1 - i;
    const bit = (hash >> BigInt(bitPos)) & 1n;
    if (i % 2 === 0) {
      col = (col << 1n) | bit;
    } else {
      row = (row << 1n) | bit;
    }
  }
  return { row, col, latBits, lngBits };
}

/** Encodes a point to a geohash integer at the given bit precision (even or odd; longitude gets
 * the extra bit when odd). `bits` must be in (0, MAX_BITS]. */
export function encode(point: LatLng, bits: number): bigint {
  if (bits <= 0 || bits > MAX_BITS) {
    throw new Error(`bits must be between 1 and ${MAX_BITS}, got ${bits}`);
  }
  const { row, col } = cellOf(point, bits);
  const { latBits, lngBits } = bitSplit(bits);
  return interleave(col, lngBits, row, latBits);
}

export interface DecodedGeohash {
  lat: number;
  lng: number;
  latErrorDeg: number;
  lngErrorDeg: number;
}

/** Decodes a geohash integer back to its cell's center point and error margins (half the cell's
 * height/width) — the true point could be anywhere within `±error` of the returned center. */
export function decode(hash: bigint, bits: number): DecodedGeohash {
  const { row, col } = deinterleave(hash, bits);
  const bounds = cellBounds({ row, col }, bits);
  return {
    lat: bounds.lat,
    lng: bounds.lng,
    latErrorDeg: bounds.latErrorDeg,
    lngErrorDeg: bounds.lngErrorDeg,
  };
}

export type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * The 8 grid cells adjacent to `cell` at the same precision — this is the direct answer to the
 * "boundary-adjacent-cell problem": a point near the edge of its own cell can have a true nearest
 * neighbor sitting just across that edge, in one of these 8 cells, so any correct search must
 * check them too rather than trusting the query point's own cell alone. Handles both longitude
 * wraparound (antimeridian) and latitude clamping (poles) — the row/col deltas are the same in
 * both cases, but wrapping the *column* index (mod cellsAcross) rather than clamping is what
 * makes crossing ±180° longitude correct instead of silently truncated.
 */
export function neighborCells(cell: GridCell, bits: number): Record<Direction, GridCell> {
  const { latBits, lngBits } = bitSplit(bits);
  const rowCount = BigInt(2 ** latBits);
  const colCount = BigInt(2 ** lngBits);

  const wrapCol = (col: bigint): bigint => ((col % colCount) + colCount) % colCount;
  // Latitude doesn't wrap (there's no "north of the north pole") — clamp instead.
  const clampRow = (row: bigint): bigint => (row < 0n ? 0n : row >= rowCount ? rowCount - 1n : row);

  const { row, col } = cell;
  return {
    n: { row: clampRow(row + 1n), col },
    s: { row: clampRow(row - 1n), col },
    e: { row, col: wrapCol(col + 1n) },
    w: { row, col: wrapCol(col - 1n) },
    ne: { row: clampRow(row + 1n), col: wrapCol(col + 1n) },
    nw: { row: clampRow(row + 1n), col: wrapCol(col - 1n) },
    se: { row: clampRow(row - 1n), col: wrapCol(col + 1n) },
    sw: { row: clampRow(row - 1n), col: wrapCol(col - 1n) },
  };
}

export function cellHash(cell: GridCell, bits: number): bigint {
  const { latBits, lngBits } = bitSplit(bits);
  return interleave(cell.col, lngBits, cell.row, latBits);
}

/**
 * Chooses the finest (largest) bit precision whose cell dimensions are still >= radiusMeters in
 * both directions, evaluated at `atLat` (longitude cell width shrinks toward the poles — the
 * same reason Redis's own `geohashEstimateStepsByRadius` takes a latitude parameter). A radius
 * search scanning the 3x3 block of cells at this precision is then guaranteed to cover the full
 * requested radius from any point inside the center cell.
 */
export function precisionForRadius(radiusMeters: number, atLat: number): number {
  const cosLat = Math.max(Math.cos((clampLat(atLat) * Math.PI) / 180), 1e-6);
  for (let bits = MAX_BITS; bits >= 2; bits -= 2) {
    const { latBits, lngBits } = bitSplit(bits);
    const latSpanMeters = (180 / 2 ** latBits) * METERS_PER_DEGREE_LAT;
    const lngSpanMeters = (360 / 2 ** lngBits) * METERS_PER_DEGREE_LAT * cosLat;
    if (latSpanMeters >= radiusMeters && lngSpanMeters >= radiusMeters) {
      return bits;
    }
  }
  return 2;
}
