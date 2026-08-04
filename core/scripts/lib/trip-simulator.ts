import { haversineDistanceMeters, type LatLng } from "../../src/services/haversine";
import { getRushHourMultiplier } from "../../src/services/eta-heuristic";

// Same San Francisco bounding box used by core/scripts/seed.ts — duplicated here (not imported)
// because the two scripts are independent, standalone entry points and this is the only thing
// they'd otherwise need to share.
export const SF_BBOX = {
  minLat: 37.708,
  maxLat: 37.812,
  minLng: -122.514,
  maxLng: -122.386,
};

// A real point inside the seeded SF bbox to treat as "downtown" for the zone-density signal
// below (Union Square / Financial District-ish — the same reference point used elsewhere in
// this project, e.g. test/eta.service.test.ts's PICKUP constant).
export const CITY_CENTER: LatLng = { lat: 37.7749, lng: -122.4194 };

/** Small seeded PRNG (mulberry32) — same one used in core/scripts/seed.ts, so the whole dataset
 * is reproducible from a single integer seed with no external randomness source. */
export function createSeededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Relative trip-request volume by local hour-of-day (0-23) — a hand-authored, plausible rideshare
// demand curve (very low overnight, morning commute bump, steady midday, a taller evening commute
// + nightlife bump), NOT calibrated to any real ridership data. This is deliberately independent
// from RUSH_HOUR_TABLE (docs/eta.md): this table controls how many trips get REQUESTED in a given
// hour, while the rush-hour multiplier below controls how much SLOWER an in-progress trip is
// during that hour — two different real-world phenomena that happen to peak at similar times.
export const HOURLY_REQUEST_WEIGHTS: number[] = [
  0.3, 0.2, 0.15, 0.15, 0.2, 0.4, // 0-5: overnight lull
  0.7, 1.4, 1.6, 1.3, 0.9, 0.8, // 6-11: rising into/through the morning commute (peak 7-8)
  0.9, 0.9, 0.85, 0.9, 1.0, 1.3, // 12-17: steady midday, starting to rise into evening commute
  1.7, 1.6, 1.2, 1.0, 0.8, 0.5, // 18-23: evening commute peak (18-19), tapering through the night
];

/** Weighted draw of an hour-of-day (0-23) from `weights`, using `rng()` (must return [0,1)). */
export function pickWeightedHour(rng: () => number, weights: number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let r = rng() * total;
  for (let hour = 0; hour < weights.length; hour++) {
    r -= weights[hour]!;
    if (r <= 0) return hour;
  }
  return weights.length - 1; // floating-point rounding fallback — should be unreachable
}

function randomPointInBbox(rng: () => number, bbox: typeof SF_BBOX): LatLng {
  return {
    lat: bbox.minLat + rng() * (bbox.maxLat - bbox.minLat),
    lng: bbox.minLng + rng() * (bbox.maxLng - bbox.minLng),
  };
}

/** Picks a random pickup/dropoff pair within `bbox`, resampling the dropoff (bounded attempts)
 * until the pair is at least `minDistanceMeters` apart — avoids degenerate near-zero-length trips
 * that wouldn't be a "plausible" ride. */
export function generatePickupDropoff(
  rng: () => number,
  bbox: typeof SF_BBOX,
  minDistanceMeters: number,
  maxAttempts = 50,
): { pickup: LatLng; dropoff: LatLng } {
  const pickup = randomPointInBbox(rng, bbox);
  let dropoff = randomPointInBbox(rng, bbox);
  let attempts = 0;
  while (haversineDistanceMeters(pickup, dropoff) < minDistanceMeters && attempts < maxAttempts) {
    dropoff = randomPointInBbox(rng, bbox);
    attempts++;
  }
  return { pickup, dropoff };
}

/** Zone-density slowdown proxy: 1.0 far from `center`, rising smoothly to `1 + maxSlowdown` right
 * at `center` — a stand-in for "denser/more congested downtown" without any real zone/
 * neighborhood data. Monotonically decreasing in distance, so it's a genuine, learnable
 * location-based feature (Phase 9's "traffic/density proxy derived from the simulated data"). */
export function computeZoneDensityFactor(
  point: LatLng,
  center: LatLng,
  maxSlowdown: number,
  decayKm: number,
): number {
  const distanceKm = haversineDistanceMeters(point, center) / 1000;
  return 1 + maxSlowdown * Math.exp(-distanceKm / decayKm);
}

export interface SimulatorConfig {
  seed: number;
  tripCount: number;
  /** Simulated requests span the `days` days immediately before `endDate`. */
  days: number;
  /** Reference "now" for the simulated range — a fixed value by default (not wall-clock `now`)
   * specifically so the dataset is reproducible independent of when the script is actually run. */
  endDate: Date;
  avgSpeedMetersPerSecond: number;
  /** Actual (road-network) distance = naive (straight-line) distance * uniform(min,max). */
  circuityFactorRange: [number, number];
  /** Independent per-trip random noise multiplier applied to actual duration — pure unpredictable
   * variance with no learnable pattern (irreducible error a good model shouldn't fully explain). */
  noiseFactorRange: [number, number];
  densityMaxSlowdown: number;
  densityDecayKm: number;
  minTripDistanceMeters: number;
  bbox: typeof SF_BBOX;
  cityCenter: LatLng;
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  seed: 42,
  tripCount: 5000,
  days: 30,
  endDate: new Date(2026, 0, 1), // local wall-clock Jan 1, 2026 — see rationale above
  avgSpeedMetersPerSecond: 8, // matches ETA_AVG_SPEED_MPS's default (docs/eta.md) for narrative consistency
  circuityFactorRange: [1.15, 1.35],
  noiseFactorRange: [0.85, 1.15],
  densityMaxSlowdown: 0.6,
  densityDecayKm: 3,
  minTripDistanceMeters: 500,
  bbox: SF_BBOX,
  cityCenter: CITY_CENTER,
};

export interface SimulatedTrip {
  pickup: LatLng;
  dropoff: LatLng;
  requestedAt: Date;
  naiveDistanceMeters: number;
  naiveDurationSeconds: number;
  actualDistanceMeters: number;
  actualDurationSeconds: number;
  timeOfDayMultiplier: number;
  zoneDensityFactor: number;
  noiseFactor: number;
}

function addLocalDays(date: Date, deltaDays: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + deltaDays);
  return d;
}

/**
 * Generates `config.tripCount` simulated trips, fully deterministic given `config` (a single
 * seeded PRNG instance drives every random choice, in a fixed order). See
 * docs/historical-data-simulator.md for the full duration formula and the reasoning behind each
 * of the three independent injected-variance factors (time-of-day, zone density, noise).
 *
 * Timestamps are built via local Date getters/setters (not UTC arithmetic) so that
 * `getRushHourMultiplier` — which reads `Date.prototype.getHours()` in the process's local time
 * zone, same as the live ETA heuristic (docs/eta.md) — sees exactly the hour this function
 * intended, regardless of the ambient TZ the process happens to run under. That means
 * reproducibility (same seed -> same dataset) holds for a fixed environment/TZ, the same known
 * scope as the ETA heuristic itself.
 */
export function generateTrips(config: SimulatorConfig): SimulatedTrip[] {
  const rng = createSeededRandom(config.seed);
  const trips: SimulatedTrip[] = [];

  for (let i = 0; i < config.tripCount; i++) {
    const dayOffset = Math.floor(rng() * config.days);
    const hour = pickWeightedHour(rng, HOURLY_REQUEST_WEIGHTS);
    const minute = Math.floor(rng() * 60);
    const second = Math.floor(rng() * 60);

    const base = addLocalDays(config.endDate, -dayOffset);
    const requestedAt = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      hour,
      minute,
      second,
      0,
    );

    const { pickup, dropoff } = generatePickupDropoff(
      rng,
      config.bbox,
      config.minTripDistanceMeters,
    );

    const naiveDistanceMeters = haversineDistanceMeters(pickup, dropoff);
    const naiveDurationSeconds = naiveDistanceMeters / config.avgSpeedMetersPerSecond;

    const [circuityMin, circuityMax] = config.circuityFactorRange;
    const circuityFactor = circuityMin + rng() * (circuityMax - circuityMin);
    const actualDistanceMeters = naiveDistanceMeters * circuityFactor;

    const timeOfDayMultiplier = getRushHourMultiplier(requestedAt);

    const midpoint: LatLng = {
      lat: (pickup.lat + dropoff.lat) / 2,
      lng: (pickup.lng + dropoff.lng) / 2,
    };
    const zoneDensityFactor = computeZoneDensityFactor(
      midpoint,
      config.cityCenter,
      config.densityMaxSlowdown,
      config.densityDecayKm,
    );

    const [noiseMin, noiseMax] = config.noiseFactorRange;
    const noiseFactor = noiseMin + rng() * (noiseMax - noiseMin);

    const actualDurationSeconds =
      (actualDistanceMeters / config.avgSpeedMetersPerSecond) *
      timeOfDayMultiplier *
      zoneDensityFactor *
      noiseFactor;

    trips.push({
      pickup,
      dropoff,
      requestedAt,
      naiveDistanceMeters,
      naiveDurationSeconds,
      actualDistanceMeters,
      actualDurationSeconds,
      timeOfDayMultiplier,
      zoneDensityFactor,
      noiseFactor,
    });
  }

  return trips;
}
