import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, sleep } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import { hasDriverConnection, getDriverSocketForTests } from "../src/ws/driver-connections";
import { runHeartbeatSweep, isTrackedForTests, markDeadForTests } from "../src/ws/heartbeat";

async function makeOnlineDriver() {
  return createDriver({
    name: "Heartbeat Driver",
    vehicleMake: "Ford",
    vehicleModel: "Focus",
    vehicleColor: "black",
    vehiclePlate: `HB${Math.floor(Math.random() * 100000)}`,
    status: "online",
  });
}

describe("ws heartbeat sweep", () => {
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

  it("a live connection survives a sweep (ping sent, still tracked)", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    const serverSocket = getDriverSocketForTests(driver.id);
    expect(serverSocket).toBeDefined();
    expect(isTrackedForTests(serverSocket!)).toBe(true);

    runHeartbeatSweep();

    // Still tracked (sweep pinged it, didn't terminate it) and still registered.
    expect(isTrackedForTests(serverSocket!)).toBe(true);
    expect(hasDriverConnection(driver.id)).toBe(true);

    client.socket.terminate();
    await app.close();
  });

  it("terminates and cleans up a connection that missed its pong", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    const serverSocket = getDriverSocketForTests(driver.id);
    expect(serverSocket).toBeDefined();

    // Simulate a connection that never responded to the previous ping.
    markDeadForTests(serverSocket!);
    runHeartbeatSweep();

    expect(isTrackedForTests(serverSocket!)).toBe(false);
    await sleep(50); // let the resulting "close" event's cleanup handler run
    expect(hasDriverConnection(driver.id)).toBe(false);

    await app.close();
  });
});
