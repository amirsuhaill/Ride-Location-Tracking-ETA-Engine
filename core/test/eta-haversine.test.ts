import { describe, expect, it } from "vitest";
import { haversineDistanceMeters } from "../src/services/haversine";

describe("haversine: haversineDistanceMeters", () => {
  it("matches the known great-circle distance between JFK and LAX within 1%", () => {
    // JFK: 40.6413N, 73.7781W; LAX: 33.9416N, 118.4085W. Commonly cited great-circle distance:
    // ~2,475 mi / ~3,983 km (e.g. gcmap.com, airmilescalculator.com). Our spherical
    // mean-Earth-radius model computes ~3,974 km — within ~0.2% of that commonly-cited
    // (ellipsoidal/geodesic) figure, which is the expected gap between a spherical and an
    // ellipsoidal model at this distance (see docs/eta.md).
    const meters = haversineDistanceMeters(
      { lat: 40.6413, lng: -73.7781 },
      { lat: 33.9416, lng: -118.4085 },
    );
    const km = meters / 1000;
    expect(km).toBeGreaterThan(3_983 * 0.99);
    expect(km).toBeLessThan(3_983 * 1.01);
  });

  it("matches the known great-circle distance between SFO and LAX within 1%", () => {
    // SFO: 37.6213N, 122.3790W; LAX: 33.9416N, 118.4085W. Commonly cited: ~337 mi / ~543 km.
    const meters = haversineDistanceMeters(
      { lat: 37.6213, lng: -122.379 },
      { lat: 33.9416, lng: -118.4085 },
    );
    const km = meters / 1000;
    expect(km).toBeGreaterThan(543 * 0.99);
    expect(km).toBeLessThan(543 * 1.01);
  });

  it("returns 0 for the same point", () => {
    const point = { lat: 37.7749, lng: -122.4194 };
    expect(haversineDistanceMeters(point, point)).toBe(0);
  });

  it("matches the mean-Earth-radius definition of one degree of latitude", () => {
    // One degree of latitude = R * (pi/180) for a sphere of radius R, independent of location —
    // with R = 6,371,000m (this project's chosen mean radius, see docs/eta.md) that's
    // ~111,194.9m. This independently checks the constant/formula, not just the formula against
    // itself.
    const meters = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(meters).toBeGreaterThan(111_194);
    expect(meters).toBeLessThan(111_196);
  });

  it("is symmetric — distance(a, b) equals distance(b, a)", () => {
    const a = { lat: 37.7749, lng: -122.4194 };
    const b = { lat: 37.8044, lng: -122.2712 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });
});
