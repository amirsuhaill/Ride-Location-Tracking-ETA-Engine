import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, expectWsRejection, sleep } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import * as driversRepo from "../src/repositories/drivers.repository";
import { hasDriverConnection, getDriverConnectionCount } from "../src/ws/driver-connections";
import { flushBatch } from "../src/ws/location-batch";
import {
  decodeLocationMessage,
  type LastKnownState,
  type LocationBroadcastPayload,
} from "../src/ws/delta-compression";

async function makeOnlineDriver() {
  return createDriver({
    name: "WS Driver",
    vehicleMake: "Toyota",
    vehicleModel: "Corolla",
    vehicleColor: "blue",
    vehiclePlate: `WS${Math.floor(Math.random() * 100000)}`,
    status: "online",
  });
}

describe("ws-driver: /ws/driver", () => {
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

  it("connects and receives a connected ack for a valid driverId", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();

    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    const ack = await client.waitForMessage((m) => m.type === "connected");
    expect(ack.driverId).toBe(driver.id);
    expect(hasDriverConnection(driver.id)).toBe(true);

    client.socket.terminate();
    await app.close();
  });

  it("rejects the upgrade when driverId is missing", async () => {
    const app = makeWsApp();
    await app.ready();
    const err = await expectWsRejection(app, "/ws/driver");
    expect(err.message).toMatch(/400/);
    await app.close();
  });

  it("rejects the upgrade when driverId does not reference an existing driver", async () => {
    const app = makeWsApp();
    await app.ready();
    const err = await expectWsRejection(app, `/ws/driver?driverId=${uuidv4()}`);
    expect(err.message).toMatch(/404/);
    await app.close();
  });

  it("processes a valid location update (updates Postgres)", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();

    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    client.socket.send(JSON.stringify({ lat: 37.7749, lng: -122.4194, timestamp: Date.now() }));
    await sleep(20); // let the throttle release enqueue the update
    await flushBatch(); // background jobs are off in tests — flush the fleet-wide batch directly

    const updated = await driversRepo.findDriverById(driver.id);
    expect(updated?.location?.lat).toBeCloseTo(37.7749, 4);
    expect(updated?.location?.lng).toBeCloseTo(-122.4194, 4);

    client.socket.terminate();
    await app.close();
  });

  it("rejects malformed JSON without crashing the connection or affecting other clients", async () => {
    const app = makeWsApp();
    await app.ready();
    const driverA = await makeOnlineDriver();
    const driverB = await makeOnlineDriver();

    const clientA = await connectWs(app, `/ws/driver?driverId=${driverA.id}`);
    await clientA.waitForMessage((m) => m.type === "connected");
    const clientB = await connectWs(app, `/ws/driver?driverId=${driverB.id}`);
    await clientB.waitForMessage((m) => m.type === "connected");

    clientA.socket.send("{ this is not valid json");
    const errorAck = await clientA.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/malformed JSON/i);
    expect(clientA.socket.readyState).toBe(clientA.socket.OPEN);

    // Other client, and the server itself, are unaffected.
    clientB.socket.send(JSON.stringify({ lat: 1, lng: 1, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const updatedB = await driversRepo.findDriverById(driverB.id);
    expect(updatedB?.location?.lat).toBeCloseTo(1, 4);

    clientA.socket.terminate();
    clientB.socket.terminate();
    await app.close();
  });

  it("rejects out-of-range coordinates (lat=200) with an error ack, not a crash", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    client.socket.send(JSON.stringify({ lat: 200, lng: 0, timestamp: Date.now() }));
    const errorAck = await client.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/lat/);
    expect(client.socket.readyState).toBe(client.socket.OPEN);

    client.socket.terminate();
    await app.close();
  });

  it("rejects a NaN-shaped update (serialized as lat: null) with an error ack", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    // JSON.stringify({ lat: NaN }) actually produces {"lat":null} in real JS clients — this is
    // what a buggy client's NaN looks like on the wire.
    client.socket.send(JSON.stringify({ lat: null, lng: 0, timestamp: Date.now() }));
    const errorAck = await client.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/lat/);

    client.socket.terminate();
    await app.close();
  });

  it("rejects raw malformed JSON containing a literal NaN token without crashing", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    client.socket.send(`{"lat": NaN, "lng": 0, "timestamp": ${Date.now()}}`);
    const errorAck = await client.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/malformed JSON/i);
    expect(client.socket.readyState).toBe(client.socket.OPEN);

    client.socket.terminate();
    await app.close();
  });

  it("rejects a timestamp far in the future", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const client = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await client.waitForMessage((m) => m.type === "connected");

    client.socket.send(JSON.stringify({ lat: 1, lng: 1, timestamp: Date.now() + 999_999_999 }));
    const errorAck = await client.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/timestamp/);

    client.socket.terminate();
    await app.close();
  });

  it("throttles and coalesces: only a few updates are processed, and the last value wins", async () => {
    const app = makeWsApp({ ws: { driverThrottleMs: 300 } });
    await app.ready();
    const driver = await makeOnlineDriver();

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");

    const totalSends = 7;
    for (let i = 1; i <= totalSends; i++) {
      driverClient.socket.send(JSON.stringify({ lat: i, lng: i, timestamp: Date.now() }));
      await sleep(80); // 7 * 80ms ≈ 560ms of sending, throttle window is 300ms
      // Background jobs are off in tests, so drive the batch flush directly on each tick —
      // equivalent to (and more deterministic than) the real setInterval-driven loop.
      await flushBatch();
    }

    // The per-driver throttle's own release timing is real-wall-clock (a genuine setTimeout,
    // same as production), so exactly when the final coalesced value lands isn't perfectly
    // predictable under test-runner load — poll rather than assume one fixed delay is enough.
    function decodeAll(): { count: number; lastKnown: LastKnownState | null } {
      const locationMessages = subscriber.messages.filter(
        (m) => m.type === "location" || m.type === "delta",
      ) as unknown as LocationBroadcastPayload[];
      let lastKnown: LastKnownState | null = null;
      for (const message of locationMessages) {
        lastKnown = decodeLocationMessage(lastKnown, message);
      }
      return { count: locationMessages.length, lastKnown };
    }

    let result = decodeAll();
    for (let attempt = 0; attempt < 20 && result.lastKnown?.lat !== totalSends; attempt++) {
      await sleep(50);
      await flushBatch();
      result = decodeAll();
    }

    // ~560ms of sends at a 300ms throttle window should yield roughly 2-3 processed updates,
    // never anywhere near the 7 raw sends.
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThan(totalSends);
    expect(result.count).toBeLessThanOrEqual(4);

    // Coalesce = last-value-wins: decoding the full delta chain must reconstruct the LAST sent
    // value, not the first (which is what a naive "process only the first in each window" drop
    // strategy would have produced).
    expect(result.lastKnown?.lat).toBe(totalSends);

    driverClient.socket.terminate();
    subscriber.socket.terminate();
    await app.close();
  });

  it("reconnect: a second connection for the same driverId replaces the first, no duplicate state", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();

    const first = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await first.waitForMessage((m) => m.type === "connected");
    expect(getDriverConnectionCount()).toBe(1);

    const second = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await second.waitForMessage((m) => m.type === "connected");

    await sleep(50);
    expect(getDriverConnectionCount()).toBe(1);
    expect(first.socket.readyState).not.toBe(first.socket.OPEN);

    // The new connection is fully functional.
    second.socket.send(JSON.stringify({ lat: 5, lng: 5, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const updated = await driversRepo.findDriverById(driver.id);
    expect(updated?.location?.lat).toBeCloseTo(5, 4);

    second.socket.terminate();
    await app.close();
  });
});
