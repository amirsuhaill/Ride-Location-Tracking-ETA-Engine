import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { createDriver } from "../src/services/drivers.service";
import { upsertDriverLocation } from "../src/repositories/drivers.geo.repository";
import { reconcileStaleDrivers } from "../src/services/reconciliation.service";

describe("reconciliation.service", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("evicts a stale online driver from Redis and marks them offline in Postgres", async () => {
    const driver = await createDriver({
      name: "Stale Sam",
      vehicleMake: "Honda",
      vehicleModel: "Civic",
      vehicleColor: "red",
      vehiclePlate: "STALE1",
      status: "online",
    });
    await upsertDriverLocation(driver.id, 37.7749, -122.4194, "online");

    // Simulate a driver who went silent a while ago by backdating their Redis hash directly —
    // in production this state arises simply by *not* calling upsertDriverLocation again.
    await redis.hset(`driver:${driver.id}:state`, {
      status: "online",
      lastUpdatedAtMs: Date.now() - 1_000_000,
    });

    const evictedCount = await reconcileStaleDrivers(Date.now());
    expect(evictedCount).toBe(1);

    const score = await redis.zscore("drivers:geo", driver.id);
    expect(score).toBeNull();

    const state = await redis.hgetall(`driver:${driver.id}:state`);
    expect(state.status).toBe("offline");

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM drivers WHERE id = $1",
      [driver.id],
    );
    expect(rows[0]?.status).toBe("offline");
  });

  it("leaves a fresh online driver untouched", async () => {
    const driver = await createDriver({
      name: "Fresh Fiona",
      vehicleMake: "Kia",
      vehicleModel: "Soul",
      vehicleColor: "green",
      vehiclePlate: "FRESH1",
      status: "online",
    });
    await upsertDriverLocation(driver.id, 37.7749, -122.4194, "online");

    const evictedCount = await reconcileStaleDrivers(Date.now());
    expect(evictedCount).toBe(0);

    const score = await redis.zscore("drivers:geo", driver.id);
    expect(score).not.toBeNull();

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM drivers WHERE id = $1",
      [driver.id],
    );
    expect(rows[0]?.status).toBe("online");
  });

  it("has nothing to do for a driver who never had a Redis entry", async () => {
    await createDriver({
      name: "Offline Oscar",
      vehicleMake: "Ford",
      vehicleModel: "Focus",
      vehicleColor: "black",
      vehiclePlate: "OFFLN1",
      status: "offline",
    });

    const evictedCount = await reconcileStaleDrivers(Date.now());
    expect(evictedCount).toBe(0);
  });
});
