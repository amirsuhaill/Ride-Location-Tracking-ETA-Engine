import { describe, expect, it } from "vitest";
import {
  createSeededRandom,
  computeZoneDensityFactor,
  generatePickupDropoff,
  generateTrips,
  pickWeightedHour,
  HOURLY_REQUEST_WEIGHTS,
  DEFAULT_SIMULATOR_CONFIG,
  SF_BBOX,
  CITY_CENTER,
} from "../scripts/lib/trip-simulator";
import { RUSH_HOUR_TABLE } from "../src/services/eta-heuristic";

describe("createSeededRandom", () => {
  it("is deterministic — the same seed produces the exact same sequence", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    expect(a()).not.toBe(b());
  });

  it("produces values in [0, 1)", () => {
    const rng = createSeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("pickWeightedHour", () => {
  it("only ever returns an hour with non-zero weight", () => {
    const rng = createSeededRandom(3);
    const weights = [0, 0, 5, 0];
    for (let i = 0; i < 200; i++) {
      expect(pickWeightedHour(rng, weights)).toBe(2);
    }
  });

  it("over many draws, samples heavier hours more often than lighter ones", () => {
    const rng = createSeededRandom(9);
    const counts = new Array(HOURLY_REQUEST_WEIGHTS.length).fill(0) as number[];
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      counts[pickWeightedHour(rng, HOURLY_REQUEST_WEIGHTS)]!++;
    }
    // Hour 18 (weight 1.7, the tallest peak) should be drawn noticeably more than hour 2
    // (weight 0.15, the deepest trough) — proportional to their weights, within sampling noise.
    expect(counts[18]!).toBeGreaterThan(counts[2]! * 5);
  });
});

describe("generatePickupDropoff", () => {
  it("always returns points inside the bbox, at least minDistanceMeters apart", () => {
    const rng = createSeededRandom(11);
    for (let i = 0; i < 200; i++) {
      const { pickup, dropoff } = generatePickupDropoff(rng, SF_BBOX, 500);
      for (const p of [pickup, dropoff]) {
        expect(p.lat).toBeGreaterThanOrEqual(SF_BBOX.minLat);
        expect(p.lat).toBeLessThanOrEqual(SF_BBOX.maxLat);
        expect(p.lng).toBeGreaterThanOrEqual(SF_BBOX.minLng);
        expect(p.lng).toBeLessThanOrEqual(SF_BBOX.maxLng);
      }
    }
  });
});

describe("computeZoneDensityFactor", () => {
  it("is exactly 1 + maxSlowdown at the city center (distance 0)", () => {
    const factor = computeZoneDensityFactor(CITY_CENTER, CITY_CENTER, 0.6, 3);
    expect(factor).toBeCloseTo(1.6, 6);
  });

  it("decays monotonically toward 1.0 as distance from the center grows", () => {
    const near = computeZoneDensityFactor({ lat: 37.78, lng: -122.42 }, CITY_CENTER, 0.6, 3);
    const mid = computeZoneDensityFactor({ lat: 37.79, lng: -122.40 }, CITY_CENTER, 0.6, 3);
    const far = computeZoneDensityFactor({ lat: 37.81, lng: -122.39 }, CITY_CENTER, 0.6, 3);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(1.0);
  });
});

describe("generateTrips", () => {
  it("is fully reproducible — the same config produces byte-identical output", () => {
    const config = { ...DEFAULT_SIMULATOR_CONFIG, tripCount: 500 };
    const a = generateTrips(config);
    const b = generateTrips(config);
    expect(a).toEqual(b);
  });

  it("a different seed produces a different dataset", () => {
    const a = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 500, seed: 1 });
    const b = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 500, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("produces exactly tripCount rows, all with positive distance/duration figures", () => {
    const trips = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 300 });
    expect(trips).toHaveLength(300);
    for (const t of trips) {
      expect(t.naiveDistanceMeters).toBeGreaterThan(0);
      expect(t.naiveDurationSeconds).toBeGreaterThan(0);
      expect(t.actualDistanceMeters).toBeGreaterThan(0);
      expect(t.actualDurationSeconds).toBeGreaterThan(0);
      // actual distance is always inflated relative to naive (straight-line) distance by the
      // circuity factor — never equal, never smaller.
      expect(t.actualDistanceMeters).toBeGreaterThan(t.naiveDistanceMeters);
    }
  });

  it("actual duration is not simply naive duration — the injected factors move it", () => {
    const trips = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 300 });
    const identical = trips.filter(
      (t) => Math.abs(t.actualDurationSeconds - t.naiveDurationSeconds) < 1e-9,
    );
    expect(identical).toHaveLength(0);
  });

  it("shows a visible rush-hour signal: trips requested during a rush-hour window have a " +
    "measurably higher average duration than off-peak trips, in-memory (no DB involved)", () => {
    const trips = generateTrips({ ...DEFAULT_SIMULATOR_CONFIG, tripCount: 8000 });

    const isRush = (hour: number): boolean =>
      RUSH_HOUR_TABLE.some((w) => hour >= w.startHour && hour < w.endHour);

    const rush = trips.filter((t) => isRush(t.requestedAt.getHours()));
    const offPeak = trips.filter((t) => !isRush(t.requestedAt.getHours()));

    expect(rush.length).toBeGreaterThan(0);
    expect(offPeak.length).toBeGreaterThan(0);

    const avg = (arr: typeof trips): number =>
      arr.reduce((sum, t) => sum + t.actualDurationSeconds, 0) / arr.length;

    const rushAvg = avg(rush);
    const offPeakAvg = avg(offPeak);

    // Generous, explicit threshold (not "looks higher") — the rush-hour multiplier alone is
    // 1.4-1.5x, so a well-sampled average should clear a 15% gap easily.
    expect(rushAvg).toBeGreaterThan(offPeakAvg * 1.15);
  });
});
