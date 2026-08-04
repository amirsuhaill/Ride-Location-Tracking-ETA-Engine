import { describe, expect, it } from "vitest";
import {
  getRushHourMultiplier,
  estimateEta,
  DEFAULT_MULTIPLIER,
  type RushHourWindow,
} from "../src/services/eta-heuristic";

function atHour(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe("eta-heuristic: getRushHourMultiplier", () => {
  it("returns the morning rush-hour multiplier during the morning window", () => {
    expect(getRushHourMultiplier(atHour(8))).toBe(1.4);
  });

  it("returns the evening rush-hour multiplier during the evening window", () => {
    expect(getRushHourMultiplier(atHour(17))).toBe(1.5);
  });

  it("returns the default multiplier (1.0) outside any rush-hour window", () => {
    expect(getRushHourMultiplier(atHour(2))).toBe(DEFAULT_MULTIPLIER);
    expect(getRushHourMultiplier(atHour(12))).toBe(DEFAULT_MULTIPLIER);
    expect(getRushHourMultiplier(atHour(22))).toBe(DEFAULT_MULTIPLIER);
  });

  it("window boundaries are start-inclusive, end-exclusive", () => {
    expect(getRushHourMultiplier(atHour(7))).toBe(1.4); // start of morning window
    expect(getRushHourMultiplier(atHour(9))).toBe(DEFAULT_MULTIPLIER); // just past it
  });

  it("is table-driven — a custom table changes the result, proving there's no hardcoded logic", () => {
    const customTable: RushHourWindow[] = [{ startHour: 12, endHour: 13, multiplier: 2 }];
    expect(getRushHourMultiplier(atHour(12), customTable)).toBe(2);
    expect(getRushHourMultiplier(atHour(8), customTable)).toBe(DEFAULT_MULTIPLIER);
  });
});

describe("eta-heuristic: estimateEta", () => {
  it("combines haversine distance, average speed, and the rush-hour multiplier correctly", () => {
    const from = { lat: 37.7749, lng: -122.4194 };
    const to = { lat: 37.7849, lng: -122.4094 };
    const cfg = { avgSpeedMetersPerSecond: 10 };

    const offPeak = estimateEta(from, to, atHour(12), cfg);
    const rushHour = estimateEta(from, to, atHour(8), cfg);

    expect(offPeak.distanceMeters).toBe(rushHour.distanceMeters); // distance itself is unaffected
    expect(offPeak.etaSeconds).toBeCloseTo(offPeak.distanceMeters / 10, 6);
    expect(rushHour.etaSeconds).toBeCloseTo(offPeak.etaSeconds * 1.4, 6);
  });

  it("a faster configured average speed produces a shorter ETA for the same distance", () => {
    const from = { lat: 37.7749, lng: -122.4194 };
    const to = { lat: 37.7849, lng: -122.4094 };

    const slow = estimateEta(from, to, atHour(12), { avgSpeedMetersPerSecond: 5 });
    const fast = estimateEta(from, to, atHour(12), { avgSpeedMetersPerSecond: 15 });

    expect(fast.etaSeconds).toBeLessThan(slow.etaSeconds);
  });
});
