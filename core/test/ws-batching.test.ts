import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, sleep } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import * as driversRepo from "../src/repositories/drivers.repository";
import {
  flushBatch,
  getPendingBatchSizeForTests,
  enqueueLocationUpdate,
} from "../src/ws/location-batch";
import { getWsConfig, MAX_BATCH_WINDOW_MS } from "../src/ws/runtime-config";

async function makeOnlineDriver(plateHint: string) {
  return createDriver({
    name: `Batch Driver ${plateHint}`,
    vehicleMake: "Subaru",
    vehicleModel: "Outback",
    vehicleColor: "silver",
    vehiclePlate: `BAT${plateHint}${Math.floor(Math.random() * 100000)}`,
    status: "online",
  });
}

describe("location-batch: fleet-wide batching", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    resetWsForTests();
  });

  afterEach(() => {
    resetWsForTests();
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("enqueue does not write anywhere until flushBatch runs", async () => {
    const driver = await makeOnlineDriver("A");
    enqueueLocationUpdate(driver.id, { lat: 10, lng: 20, timestamp: Date.now() });

    expect(getPendingBatchSizeForTests()).toBe(1);
    const beforeFlush = await driversRepo.findDriverById(driver.id);
    expect(beforeFlush?.location).toBeNull();

    await flushBatch();

    expect(getPendingBatchSizeForTests()).toBe(0);
    const afterFlush = await driversRepo.findDriverById(driver.id);
    expect(afterFlush?.location?.lat).toBeCloseTo(10, 4);
  });

  it("a single flush covers multiple different drivers' updates together", async () => {
    const driverA = await makeOnlineDriver("B");
    const driverB = await makeOnlineDriver("C");
    const driverC = await makeOnlineDriver("D");

    enqueueLocationUpdate(driverA.id, { lat: 1, lng: 1, timestamp: Date.now() });
    enqueueLocationUpdate(driverB.id, { lat: 2, lng: 2, timestamp: Date.now() });
    enqueueLocationUpdate(driverC.id, { lat: 3, lng: 3, timestamp: Date.now() });
    expect(getPendingBatchSizeForTests()).toBe(3);

    await flushBatch();

    const [a, b, c] = await Promise.all([
      driversRepo.findDriverById(driverA.id),
      driversRepo.findDriverById(driverB.id),
      driversRepo.findDriverById(driverC.id),
    ]);
    expect(a?.location?.lat).toBeCloseTo(1, 4);
    expect(b?.location?.lat).toBeCloseTo(2, 4);
    expect(c?.location?.lat).toBeCloseTo(3, 4);

    // And Redis's geo index picked up all three too.
    const scores = await Promise.all(
      [driverA, driverB, driverC].map((d) => redis.zscore("drivers:geo", d.id)),
    );
    expect(scores.every((s) => s !== null)).toBe(true);
  });

  it("enqueuing twice for the same driver before a flush keeps only the last value (last-value-wins)", async () => {
    const driver = await makeOnlineDriver("E");
    // Distinct, in-range lat/lng (location-batch trusts its caller for range validity — that's
    // enforced at the WS message boundary, see src/ws/messages.ts — so realistic values here,
    // not just anything that happens to round-trip through PostGIS's geography type unchanged).
    enqueueLocationUpdate(driver.id, { lat: 1, lng: 2, timestamp: Date.now() });
    enqueueLocationUpdate(driver.id, { lat: 45, lng: 60, timestamp: Date.now() });
    expect(getPendingBatchSizeForTests()).toBe(1);

    await flushBatch();

    const updated = await driversRepo.findDriverById(driver.id);
    expect(updated?.location?.lat).toBeCloseTo(45, 4);
    expect(updated?.location?.lng).toBeCloseTo(60, 4);
  });

  it("flushing an empty batch is a harmless no-op", async () => {
    expect(getPendingBatchSizeForTests()).toBe(0);
    await expect(flushBatch()).resolves.toBeUndefined();
  });

  it("the batch window is configurable per server instance", async () => {
    const app = makeWsApp({ ws: { batchWindowMs: 234 } });
    await app.ready();
    expect(getWsConfig().batchWindowMs).toBe(234);
    await app.close();
  });

  it("the batch window is hard-capped at MAX_BATCH_WINDOW_MS regardless of configured value", async () => {
    const app = makeWsApp({ ws: { batchWindowMs: MAX_BATCH_WINDOW_MS + 5000 } });
    await app.ready();
    expect(getWsConfig().batchWindowMs).toBe(MAX_BATCH_WINDOW_MS);
    await app.close();
  });

  it("a full send-to-broadcast path (driver WS -> batch -> subscriber) respects the configured window", async () => {
    const app = makeWsApp({ ws: { driverThrottleMs: 10 } });
    await app.ready();
    const driver = await makeOnlineDriver("F");

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");

    driverClient.socket.send(JSON.stringify({ lat: 42, lng: 24, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();

    const locationMsg = await subscriber.waitForMessage(
      (m) => m.type === "location" || m.type === "delta",
    );
    expect(locationMsg.type).toBe("location");
    expect(locationMsg.lat).toBe(42);

    driverClient.socket.terminate();
    subscriber.socket.terminate();
    await app.close();
  });
});
