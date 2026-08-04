import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { redis } from "../src/redis";
import { resetRedis } from "./helpers/redis";
import { regionForPoint, regionsWithinRadius } from "../src/geo/regions";
import {
  upsertDriverLocation,
  removeDriver,
  searchNearby,
  isDriverInRegionShard,
  getShardMemberCount,
  resetShardedRegionsForTests,
} from "../src/repositories/sharded-driver-geo.repository";

const SF_DEEP = { lat: 37.76, lng: -122.45 }; // well inside "sf", far from the boundary
const OAKLAND_DEEP = { lat: 37.76, lng: -122.3 }; // well inside "oakland", far from the boundary
const BOUNDARY_LNG = -122.386;

describe("geo/regions: pure routing functions", () => {
  it("regionForPoint resolves points deep inside each region correctly", () => {
    expect(regionForPoint(SF_DEEP)?.id).toBe("sf");
    expect(regionForPoint(OAKLAND_DEEP)?.id).toBe("oakland");
  });

  it("regionForPoint gives the shared boundary to exactly one region (the eastern one)", () => {
    expect(regionForPoint({ lat: 37.76, lng: BOUNDARY_LNG })?.id).toBe("oakland");
    expect(regionForPoint({ lat: 37.76, lng: BOUNDARY_LNG - 0.0001 })?.id).toBe("sf");
    expect(regionForPoint({ lat: 37.76, lng: BOUNDARY_LNG + 0.0001 })?.id).toBe("oakland");
  });

  it("regionForPoint returns null outside every simulated region", () => {
    expect(regionForPoint({ lat: 40.7, lng: -74.0 })).toBeNull(); // New York
  });

  it("regionsWithinRadius includes only the owning region when far from any boundary", () => {
    expect(regionsWithinRadius(SF_DEEP, 500).map((r) => r.id)).toEqual(["sf"]);
  });

  it("regionsWithinRadius includes both regions when the radius reaches across the boundary", () => {
    const nearBoundary = { lat: 37.76, lng: BOUNDARY_LNG - 0.005 }; // ~440m west of the boundary
    expect(regionsWithinRadius(nearBoundary, 100).map((r) => r.id)).toEqual(["sf"]);
    const ids = regionsWithinRadius(nearBoundary, 1000).map((r) => r.id);
    expect(ids).toContain("sf");
    expect(ids).toContain("oakland");
  });

  it("regionsWithinRadius returns nothing for a point far outside every region", () => {
    expect(regionsWithinRadius({ lat: 40.7, lng: -74.0 }, 1000)).toEqual([]);
  });
});

describe("sharded-driver-geo.repository: per-shard routing and search", () => {
  beforeEach(async () => {
    await resetRedis();
    await resetShardedRegionsForTests();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("a driver deep in one region is found by a query in that region and not from the other", async () => {
    const driverId = uuidv4();
    const { regionId, migrated } = await upsertDriverLocation(driverId, SF_DEEP.lat, SF_DEEP.lng);
    expect(regionId).toBe("sf");
    expect(migrated).toBe(false); // first time this driver has ever been placed anywhere

    const fromSf = await searchNearby(SF_DEEP, 500, 10);
    expect(fromSf.map((r) => r.driverId)).toContain(driverId);

    const fromOakland = await searchNearby(OAKLAND_DEEP, 500, 10);
    expect(fromOakland.map((r) => r.driverId)).not.toContain(driverId);
  });

  it("upserting a point outside every simulated region is rejected, not silently dropped", async () => {
    await expect(upsertDriverLocation(uuidv4(), 40.7, -74.0)).rejects.toThrow();
  });

  it("removeDriver clears the driver from whichever shard currently holds them", async () => {
    const driverId = uuidv4();
    await upsertDriverLocation(driverId, SF_DEEP.lat, SF_DEEP.lng);
    expect(await isDriverInRegionShard(driverId, "sf")).toBe(true);

    await removeDriver(driverId);

    expect(await isDriverInRegionShard(driverId, "sf")).toBe(false);
    expect(await getShardMemberCount("sf")).toBe(0);
  });

  describe("boundary query: merges and re-sorts across shards, not a per-shard concatenation", () => {
    it("returns drivers from both shards ordered by true distance, closer-shard-result first even though it's queried second", async () => {
      // Query point sits just inside "sf", close to the shared boundary.
      const queryPoint = { lat: 37.76, lng: BOUNDARY_LNG - 0.003 }; // ~265m west of the boundary

      // Driver X: same region as the query point (sf), but placed FARTHER from the query point.
      const driverX = uuidv4();
      await upsertDriverLocation(driverX, 37.76, BOUNDARY_LNG - 0.01); // ~880m west of the boundary -> ~615m from queryPoint

      // Driver Y: across the boundary in "oakland", but placed CLOSER to the query point than X.
      const driverY = uuidv4();
      await upsertDriverLocation(driverY, 37.76, BOUNDARY_LNG + 0.002); // ~180m east of the boundary -> ~445m from queryPoint

      const results = await searchNearby(queryPoint, 2_000, 10);
      const ids = results.map((r) => r.driverId);

      expect(ids).toContain(driverX);
      expect(ids).toContain(driverY);
      // The genuine cross-shard proof: Y (in the "oakland" shard) is closer in real distance and
      // must come first, even though the query point's own region is "sf" — a naive
      // "concatenate this shard's results, then the other's" implementation would have listed
      // every "sf" result (including X) before any "oakland" result (Y), regardless of distance.
      const indexOfX = ids.indexOf(driverX);
      const indexOfY = ids.indexOf(driverY);
      expect(indexOfY).toBeLessThan(indexOfX);

      const resultX = results.find((r) => r.driverId === driverX)!;
      const resultY = results.find((r) => r.driverId === driverY)!;
      expect(resultY.distanceMeters).toBeLessThan(resultX.distanceMeters);
      expect(resultX.regionId).toBe("sf");
      expect(resultY.regionId).toBe("oakland");
    });

    it("respects the overall limit across merged shards, not a per-shard limit", async () => {
      const queryPoint = { lat: 37.76, lng: BOUNDARY_LNG };
      await upsertDriverLocation(uuidv4(), 37.76, BOUNDARY_LNG - 0.002); // sf side, close
      await upsertDriverLocation(uuidv4(), 37.76, BOUNDARY_LNG + 0.002); // oakland side, close

      const results = await searchNearby(queryPoint, 2_000, 1);
      expect(results).toHaveLength(1); // not 2 (i.e. not "1 per shard")
    });

    it("a query far from the boundary only touches its own shard, never the other region's drivers", async () => {
      const oaklandOnlyDriver = uuidv4();
      await upsertDriverLocation(oaklandOnlyDriver, OAKLAND_DEEP.lat, OAKLAND_DEEP.lng);

      const results = await searchNearby(SF_DEEP, 2_000, 10);
      expect(results).toEqual([]);
    });
  });

  describe("crossing a region boundary: no stale duplicate left in the old shard", () => {
    it("moving a driver from sf to oakland removes them from sf's shard entirely, not just from query results", async () => {
      const driverId = uuidv4();

      const first = await upsertDriverLocation(driverId, SF_DEEP.lat, SF_DEEP.lng);
      expect(first.regionId).toBe("sf");
      expect(first.migrated).toBe(false);
      expect(await isDriverInRegionShard(driverId, "sf")).toBe(true);
      expect(await getShardMemberCount("sf")).toBe(1);

      const second = await upsertDriverLocation(driverId, OAKLAND_DEEP.lat, OAKLAND_DEEP.lng);
      expect(second.regionId).toBe("oakland");
      expect(second.migrated).toBe(true);

      // The critical assertion: not "filtered out of nearby search" but genuinely absent from
      // the old shard's own sorted set (ZCARD dropping to 0 proves the key was actually removed,
      // not merely shadowed).
      expect(await isDriverInRegionShard(driverId, "sf")).toBe(false);
      expect(await getShardMemberCount("sf")).toBe(0);

      expect(await isDriverInRegionShard(driverId, "oakland")).toBe(true);
      expect(await getShardMemberCount("oakland")).toBe(1);

      // And the driver is now genuinely findable only from their new region.
      const fromOakland = await searchNearby(OAKLAND_DEEP, 500, 10);
      expect(fromOakland.map((r) => r.driverId)).toContain(driverId);
      const fromSf = await searchNearby(SF_DEEP, 500, 10);
      expect(fromSf.map((r) => r.driverId)).not.toContain(driverId);
    });

    it("repeated updates within the same region never trigger a migration or touch the other shard", async () => {
      const driverId = uuidv4();
      await upsertDriverLocation(driverId, SF_DEEP.lat, SF_DEEP.lng);

      const second = await upsertDriverLocation(driverId, SF_DEEP.lat + 0.001, SF_DEEP.lng + 0.001);
      expect(second.regionId).toBe("sf");
      expect(second.migrated).toBe(false);

      expect(await getShardMemberCount("sf")).toBe(1); // still exactly one entry, not two
      expect(await getShardMemberCount("oakland")).toBe(0);
    });
  });
});
