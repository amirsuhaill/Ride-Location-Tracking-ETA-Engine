import { describe, expect, it } from "vitest";
import { GeohashIndex } from "../src/geo/geohash-index";
import { cellOf, cellBounds, cellHash, precisionForRadius } from "../src/geo/geohash";
import { haversineDistanceMeters } from "../src/services/haversine";

const SF = { lat: 37.7749, lng: -122.4194 };

describe("GeohashIndex: basic insert/search/remove", () => {
  it("finds an inserted point within radius, sorted nearest-first", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("near", SF.lat + 0.0001, SF.lng); // ~11m north
    idx.upsert("mid", SF.lat + 0.005, SF.lng); // ~550m north
    idx.upsert("far", SF.lat + 0.5, SF.lng); // ~55km north — outside radius

    const results = idx.radiusSearch(SF, 3000);
    expect(results.map((r) => r.id)).toEqual(["near", "mid"]);
    expect(results[0]!.distanceMeters).toBeLessThan(results[1]!.distanceMeters);
  });

  it("excludes points outside the requested radius", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(1000, SF.lat) });
    idx.upsert("far", SF.lat + 0.5, SF.lng);
    expect(idx.radiusSearch(SF, 1000)).toEqual([]);
  });

  it("upsert moves a point to its new bucket, not just updates its recorded position", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("driver", SF.lat, SF.lng);
    expect(idx.radiusSearch(SF, 100)).toHaveLength(1);

    idx.upsert("driver", SF.lat + 1, SF.lng + 1); // moved ~150km away
    expect(idx.radiusSearch(SF, 100)).toEqual([]);
    expect(idx.radiusSearch({ lat: SF.lat + 1, lng: SF.lng + 1 }, 100)).toHaveLength(1);
  });

  it("remove takes a point out of the index entirely", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("driver", SF.lat, SF.lng);
    idx.remove("driver");
    expect(idx.radiusSearch(SF, 5000)).toEqual([]);
    expect(idx.size()).toBe(0);
  });

  it("size() tracks distinct ids, not bucket count", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("a", SF.lat, SF.lng);
    idx.upsert("b", SF.lat, SF.lng); // same exact point, same bucket
    idx.upsert("c", SF.lat + 1, SF.lng + 1); // different bucket
    expect(idx.size()).toBe(3);
  });
});

describe("GeohashIndex: the boundary-adjacent-cell problem, deliberately triggered", () => {
  it("finds a genuinely closer point that sits in a neighboring cell, not just the query point's own cell", () => {
    const bits = precisionForRadius(3000, SF.lat);

    // Construct the query point deliberately near the edge of its own cell (1/1000th of the
    // cell's height away from its northern boundary) — this is the exact scenario a
    // "only scan my own cell" implementation gets wrong.
    const queryCell = cellOf(SF, bits);
    const bounds = cellBounds(queryCell, bits);
    const cellTopLat = bounds.lat + bounds.latErrorDeg;
    const query = { lat: cellTopLat - bounds.latErrorDeg * 0.001, lng: bounds.lng };

    // Place the target just across that same boundary, in the cell to the north — genuinely
    // close in real distance (well within the search radius) but in a different bucket.
    const target = { lat: cellTopLat + bounds.latErrorDeg * 0.002, lng: bounds.lng };

    const targetCell = cellOf(target, bits);
    expect(cellHash(targetCell, bits)).not.toBe(cellHash(queryCell, bits)); // prove it's a genuinely different cell

    const realDistanceMeters = haversineDistanceMeters(query, target);
    expect(realDistanceMeters).toBeLessThan(50); // a few meters apart in reality

    const idx = new GeohashIndex({ bucketBits: bits });
    idx.upsert("across-the-boundary", target.lat, target.lng);

    // A naive "scan only the query point's own bucket" search would find nothing here — this
    // assertion is exactly what that naive approach would fail.
    const results = idx.radiusSearch(query, 50);
    expect(results.map((r) => r.id)).toEqual(["across-the-boundary"]);
  });

  it("nearestNeighbors also crosses cell boundaries correctly", () => {
    const bits = precisionForRadius(3000, SF.lat);
    const queryCell = cellOf(SF, bits);
    const bounds = cellBounds(queryCell, bits);
    const query = { lat: bounds.lat + bounds.latErrorDeg * 0.999, lng: bounds.lng };
    const target = { lat: bounds.lat + bounds.latErrorDeg * 1.001, lng: bounds.lng };

    expect(cellHash(cellOf(target, bits), bits)).not.toBe(cellHash(queryCell, bits));

    const idx = new GeohashIndex({ bucketBits: bits });
    idx.upsert("neighbor-cell-point", target.lat, target.lng);
    idx.upsert("far-away-point", SF.lat + 2, SF.lng + 2);

    const nearest = idx.nearestNeighbors(query, 1);
    expect(nearest).toHaveLength(1);
    expect(nearest[0]!.id).toBe("neighbor-cell-point");
  });
});

describe("GeohashIndex: nearestNeighbors", () => {
  it("returns exactly k results ordered by distance when more than k points exist", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    const offsets = [0.001, 0.002, 0.003, 0.004, 0.005];
    offsets.forEach((offset, i) => idx.upsert(`d${i}`, SF.lat + offset, SF.lng));

    const nearest = idx.nearestNeighbors(SF, 3);
    expect(nearest).toHaveLength(3);
    expect(nearest.map((r) => r.id)).toEqual(["d0", "d1", "d2"]);
  });

  it("expands its search radius until it finds a sparse point far from a dense query origin", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("distant", SF.lat + 1, SF.lng + 1); // ~150km away — well beyond the initial guess radius

    const nearest = idx.nearestNeighbors(SF, 1);
    expect(nearest).toHaveLength(1);
    expect(nearest[0]!.id).toBe("distant");
  });

  it("returns fewer than k results if the index doesn't have k points at all", () => {
    const idx = new GeohashIndex({ bucketBits: precisionForRadius(3000, SF.lat) });
    idx.upsert("only-one", SF.lat, SF.lng);
    expect(idx.nearestNeighbors(SF, 5)).toHaveLength(1);
  });
});
