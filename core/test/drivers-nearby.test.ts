import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { redis } from "../src/redis";
import { resetRedis } from "./helpers/redis";
import { destinationPoint } from "./helpers/geo";
import {
  upsertDriverLocation,
  updateDriverStatusInRedis,
  searchNearby,
} from "../src/repositories/drivers.geo.repository";

const SF_CENTER = { lat: 37.7749, lng: -122.4194 };

describe("drivers.geo.repository — nearby search", () => {
  beforeEach(async () => {
    await resetRedis();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("returns correct, distance-sorted results within a given radius (100 seeded drivers)", async () => {
    const radiusMeters = 8_000;
    const ids: string[] = [];

    for (let i = 0; i < 100; i++) {
      const id = uuidv4();
      ids.push(id);
      // Scattered at random bearings, 0-15km out — some inside the query radius, some outside,
      // by design, so the test also exercises radius filtering (not just "return everything").
      const bearing = (i / 100) * 360;
      const distance = 200 + (i % 10) * 1_500;
      const { lat, lng } = destinationPoint(SF_CENTER.lat, SF_CENTER.lng, bearing, distance);
      await upsertDriverLocation(id, lat, lng, "online");
    }

    const results = await searchNearby(SF_CENTER.lat, SF_CENTER.lng, radiusMeters, 100);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(100);
    for (const r of results) {
      expect(r.distanceMeters).toBeLessThanOrEqual(radiusMeters);
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distanceMeters).toBeGreaterThanOrEqual(results[i - 1].distanceMeters);
    }
  });

  it("boundary case: includes a driver just inside the radius, excludes one just outside", async () => {
    const radiusMeters = 2_000;
    const insideId = uuidv4();
    const outsideId = uuidv4();

    const inside = destinationPoint(SF_CENTER.lat, SF_CENTER.lng, 0, radiusMeters - 50);
    const outside = destinationPoint(SF_CENTER.lat, SF_CENTER.lng, 0, radiusMeters + 50);

    await upsertDriverLocation(insideId, inside.lat, inside.lng, "online");
    await upsertDriverLocation(outsideId, outside.lat, outside.lng, "online");

    const results = await searchNearby(SF_CENTER.lat, SF_CENTER.lng, radiusMeters, 10);
    const ids = results.map((r) => r.driverId);

    expect(ids).toContain(insideId);
    expect(ids).not.toContain(outsideId);
  });

  it("empty-result case: returns no drivers when none are within radius", async () => {
    const farAwayId = uuidv4();
    // ~200km away — well outside any reasonable query radius from SF_CENTER.
    const farAway = destinationPoint(SF_CENTER.lat, SF_CENTER.lng, 45, 200_000);
    await upsertDriverLocation(farAwayId, farAway.lat, farAway.lng, "online");

    const results = await searchNearby(SF_CENTER.lat, SF_CENTER.lng, 5_000, 10);

    expect(results).toEqual([]);
  });

  it("excludes offline and busy drivers by default", async () => {
    const onlineId = uuidv4();
    const offlineId = uuidv4();
    const busyId = uuidv4();

    // All three at effectively the same spot, close to the query center.
    await upsertDriverLocation(onlineId, SF_CENTER.lat, SF_CENTER.lng, "online");
    await upsertDriverLocation(offlineId, SF_CENTER.lat, SF_CENTER.lng, "online");
    await updateDriverStatusInRedis(offlineId, "offline");
    await upsertDriverLocation(busyId, SF_CENTER.lat, SF_CENTER.lng, "online");
    await updateDriverStatusInRedis(busyId, "busy");

    const results = await searchNearby(SF_CENTER.lat, SF_CENTER.lng, 1_000, 10);
    const ids = results.map((r) => r.driverId);

    expect(ids).toContain(onlineId);
    expect(ids).not.toContain(offlineId);
    expect(ids).not.toContain(busyId);
  });

  it("load shape: seeding 100 drivers and querying nearby completes within a bounded time", async () => {
    const seedStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const id = uuidv4();
      const bearing = (i / 100) * 360;
      const distance = 100 + (i % 20) * 400;
      const { lat, lng } = destinationPoint(SF_CENTER.lat, SF_CENTER.lng, bearing, distance);
      await upsertDriverLocation(id, lat, lng, "online");
    }
    const seedMs = performance.now() - seedStart;

    const queryStart = performance.now();
    const results = await searchNearby(SF_CENTER.lat, SF_CENTER.lng, 10_000, 20);
    const queryMs = performance.now() - queryStart;

    console.log(
      `[load-shape] seeded 100 drivers in ${seedMs.toFixed(1)}ms, ` +
        `nearby query (radius=10km, limit=20) returned ${results.length} results in ${queryMs.toFixed(1)}ms`,
    );

    expect(results.length).toBeGreaterThan(0);
    // Generous bound for a local test run (single Redis round-trips per seed + one GEOSEARCH) —
    // this is a shape/regression check, not a load-test SLA (that's Phase 11).
    expect(queryMs).toBeLessThan(500);
  });
});
