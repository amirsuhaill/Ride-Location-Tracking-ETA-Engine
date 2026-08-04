import { describe, expect, it } from "vitest";
import {
  encode,
  decode,
  cellOf,
  cellHash,
  neighborCells,
  precisionForRadius,
  bitSplit,
  MAX_BITS,
} from "../src/geo/geohash";

const SF = { lat: 37.7749, lng: -122.4194 };

describe("geohash: encode/decode round-trip", () => {
  it.each([4, 10, 20, 30, 40, 52])(
    "decodes within the cell's own error bounds at %i bits",
    (bits) => {
      const hash = encode(SF, bits);
      const decoded = decode(hash, bits);
      expect(Math.abs(decoded.lat - SF.lat)).toBeLessThanOrEqual(decoded.latErrorDeg);
      expect(Math.abs(decoded.lng - SF.lng)).toBeLessThanOrEqual(decoded.lngErrorDeg);
    },
  );

  it("finer precision produces a strictly smaller error bound", () => {
    const coarse = decode(encode(SF, 20), 20);
    const fine = decode(encode(SF, 40), 40);
    expect(fine.latErrorDeg).toBeLessThan(coarse.latErrorDeg);
    expect(fine.lngErrorDeg).toBeLessThan(coarse.lngErrorDeg);
  });

  it("two nearby points at high precision usually land in different cells, but always agree at low precision", () => {
    const a = { lat: 37.7749, lng: -122.4194 };
    const b = { lat: 37.7749001, lng: -122.4194001 }; // ~0.1m away
    expect(encode(a, 4)).toBe(encode(b, 4)); // both in the same continent-scale cell
  });

  it("rejects an out-of-range bit count", () => {
    expect(() => encode(SF, 0)).toThrow();
    expect(() => encode(SF, MAX_BITS + 1)).toThrow();
  });

  it("cellHash(cellOf(point)) matches encode(point) exactly", () => {
    for (const bits of [10, 24, 33, 52]) {
      expect(cellHash(cellOf(SF, bits), bits)).toBe(encode(SF, bits));
    }
  });
});

describe("geohash: bitSplit", () => {
  it("gives longitude the extra bit when the total is odd (lng-first interleaving)", () => {
    expect(bitSplit(10)).toEqual({ latBits: 5, lngBits: 5 });
    expect(bitSplit(11)).toEqual({ latBits: 5, lngBits: 6 });
  });
});

describe("geohash: neighborCells", () => {
  it("returns 8 distinct cells, each one grid step away from the center", () => {
    const bits = 24;
    const center = cellOf(SF, bits);
    const neighbors = neighborCells(center, bits);

    const hashes = new Set(Object.values(neighbors).map((c) => cellHash(c, bits)));
    expect(hashes.size).toBe(8); // all distinct from each other
    expect(hashes.has(cellHash(center, bits))).toBe(false); // and none equal to the center itself

    expect(neighbors.n.row).toBe(center.row + 1n);
    expect(neighbors.s.row).toBe(center.row - 1n);
    expect(neighbors.e.col).toBe(center.col + 1n);
    expect(neighbors.w.col).toBe(center.col - 1n);
  });

  it("wraps longitude across the antimeridian instead of erroring or truncating", () => {
    const bits = 20;
    const nearDateline = cellOf({ lat: 10, lng: 179.999 }, bits);
    const neighbors = neighborCells(nearDateline, bits);
    const { lngBits } = bitSplit(bits);
    const colCount = 2 ** lngBits;
    // The eastward neighbor of the easternmost column must wrap around to column 0, not go out
    // of range or silently clamp to the same column.
    expect(Number(nearDateline.col)).toBe(colCount - 1);
    expect(Number(neighbors.e.col)).toBe(0);
  });

  it("clamps (does not wrap) at the poles", () => {
    const bits = 20;
    const northPole = cellOf({ lat: 89.999, lng: 0 }, bits);
    const neighbors = neighborCells(northPole, bits);
    const { latBits } = bitSplit(bits);
    const rowCount = 2 ** latBits;
    expect(Number(northPole.row)).toBe(rowCount - 1);
    expect(Number(neighbors.n.row)).toBe(rowCount - 1); // clamped, not wrapped to the south pole
  });
});

describe("geohash: precisionForRadius", () => {
  it("chooses a finer precision (more bits) for a smaller radius", () => {
    const fine = precisionForRadius(200, SF.lat);
    const coarse = precisionForRadius(50_000, SF.lat);
    expect(fine).toBeGreaterThan(coarse);
  });

  it("the chosen precision's cell is actually at least as big as the requested radius", () => {
    for (const radius of [100, 1_000, 5_000, 20_000]) {
      const bits = precisionForRadius(radius, SF.lat);
      const { latBits, lngBits } = bitSplit(bits);
      const latSpanMeters = (180 / 2 ** latBits) * 111_320;
      const lngSpanMeters = (360 / 2 ** lngBits) * 111_320 * Math.cos((SF.lat * Math.PI) / 180);
      expect(latSpanMeters).toBeGreaterThanOrEqual(radius);
      expect(lngSpanMeters).toBeGreaterThanOrEqual(radius);
    }
  });
});
