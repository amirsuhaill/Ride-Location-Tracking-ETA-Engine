import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, sleep } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import { flushBatch } from "../src/ws/location-batch";
import { getBandwidthStats } from "../src/ws/bandwidth-metrics";
import {
  encodeLocationMessage,
  decodeLocationMessage,
  QUANTIZATION_STEP_DEGREES,
  type LatLng,
  type LastKnownState,
} from "../src/ws/delta-compression";

async function makeOnlineDriver() {
  return createDriver({
    name: "Delta Driver",
    vehicleMake: "Mazda",
    vehicleModel: "3",
    vehicleColor: "gray",
    vehiclePlate: `DLT${Math.floor(Math.random() * 100000)}`,
    status: "online",
  });
}

describe("delta-compression: pure encode/decode", () => {
  const meta = { driverId: "d1", timestamp: 123, status: "online" as const };

  it("the first-ever message for a subscriber is a full payload, never a delta", () => {
    const message = encodeLocationMessage(null, { lat: 37.77, lng: -122.42 }, meta);
    expect(message.type).toBe("location");
    expect("lat" in message && message.lat).toBe(37.77);
    expect("lng" in message && message.lng).toBe(-122.42);
  });

  it("subsequent messages are delta-encoded and round-trip within quantization tolerance", () => {
    const first: LastKnownState = { lat: 37.7749, lng: -122.4194, status: "online" };
    const second: LatLng = { lat: 37.7755, lng: -122.4201 };

    const message = encodeLocationMessage(first, second, meta);
    expect(message.type).toBe("delta");

    const decoded = decodeLocationMessage(first, message);
    // Max error per axis is half a quantization step.
    expect(Math.abs(decoded.lat - second.lat)).toBeLessThanOrEqual(QUANTIZATION_STEP_DEGREES / 2);
    expect(Math.abs(decoded.lng - second.lng)).toBeLessThanOrEqual(QUANTIZATION_STEP_DEGREES / 2);
  });

  it("quantization error is well under a meter — 1e-5 degrees is ~1.11m latitude everywhere", () => {
    const metersPerDegreeLat = 111_320;
    const worstCaseLatErrorMeters = (QUANTIZATION_STEP_DEGREES / 2) * metersPerDegreeLat;
    expect(worstCaseLatErrorMeters).toBeLessThan(1);
  });

  it("omits the status field on a delta message when status hasn't changed", () => {
    const first: LastKnownState = { lat: 37.7749, lng: -122.4194, status: "online" };
    const message = encodeLocationMessage(first, { lat: 37.776, lng: -122.42 }, meta);
    expect(message.type).toBe("delta");
    expect("status" in message).toBe(false);
  });

  it("includes the status field on a delta message when status has changed", () => {
    const first: LastKnownState = { lat: 37.7749, lng: -122.4194, status: "busy" };
    const message = encodeLocationMessage(first, { lat: 37.776, lng: -122.42 }, meta);
    expect(message.type).toBe("delta");
    expect("status" in message && message.status).toBe("online");
  });

  it("a long chain of deltas does not accumulate error (always deltas against the true last position)", () => {
    let serverTruth: LatLng = { lat: 37.7749, lng: -122.4194 };
    let lastSent: LastKnownState | null = null;
    let clientReconstructed: LastKnownState | null = null;

    for (let i = 0; i < 50; i++) {
      serverTruth = { lat: serverTruth.lat + 0.0001, lng: serverTruth.lng - 0.0001 };
      const message = encodeLocationMessage(lastSent, serverTruth, meta);
      clientReconstructed = decodeLocationMessage(clientReconstructed, message);
      lastSent = { ...serverTruth, status: meta.status }; // server always deltas against the true absolute position
    }

    expect(Math.abs(clientReconstructed!.lat - serverTruth.lat)).toBeLessThanOrEqual(
      QUANTIZATION_STEP_DEGREES / 2,
    );
  });

  it("rejects decoding a delta with no prior full position", () => {
    const message = encodeLocationMessage(
      { lat: 1, lng: 1, status: "online" },
      { lat: 2, lng: 2 },
      meta,
    );
    expect(() => decodeLocationMessage(null, message)).toThrow(/no prior full position/);
  });
});

describe("delta-compression: per-subscriber state (integration)", () => {
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

  it("a subscriber's first update is full even if the driver has already broadcast to others", async () => {
    const app = makeWsApp({ ws: { driverThrottleMs: 10 } });
    await app.ready();
    const driver = await makeOnlineDriver();

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");

    const earlySubscriber = await connectWs(app, "/ws/subscribe");
    await earlySubscriber.waitForMessage((m) => m.type === "connected");
    earlySubscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await earlySubscriber.waitForMessage((m) => m.type === "subscribed");

    driverClient.socket.send(JSON.stringify({ lat: 1, lng: 1, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const earlyFirst = await earlySubscriber.waitForMessage(
      (m) => m.type === "location" || m.type === "delta",
    );
    expect(earlyFirst.type).toBe("location"); // first message for this subscriber: full

    driverClient.socket.send(JSON.stringify({ lat: 2, lng: 2, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const earlySecond = await earlySubscriber.waitForMessage(
      (m) => m !== earlyFirst && (m.type === "location" || m.type === "delta"),
    );
    expect(earlySecond.type).toBe("delta"); // second message for this subscriber: delta

    // A brand new subscriber joins now, after the driver has already been broadcasting deltas
    // to earlySubscriber for a while — it must still get a full payload first, because delta
    // compression state is per-subscriber, not global to the driver.
    const lateSubscriber = await connectWs(app, "/ws/subscribe");
    await lateSubscriber.waitForMessage((m) => m.type === "connected");
    lateSubscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await lateSubscriber.waitForMessage((m) => m.type === "subscribed");

    driverClient.socket.send(JSON.stringify({ lat: 3, lng: 3, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const lateFirst = await lateSubscriber.waitForMessage(
      (m) => m.type === "location" || m.type === "delta",
    );
    expect(lateFirst.type).toBe("location");
    expect(lateFirst.lat).toBe(3);
    expect(lateFirst.lng).toBe(3);

    driverClient.socket.terminate();
    earlySubscriber.socket.terminate();
    lateSubscriber.socket.terminate();
    await app.close();
  });

  it("bandwidth metrics show real savings after a mix of full and delta broadcasts", async () => {
    const app = makeWsApp({ ws: { driverThrottleMs: 10 } });
    await app.ready();
    const driver = await makeOnlineDriver();

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");

    for (let i = 0; i < 10; i++) {
      driverClient.socket.send(
        JSON.stringify({
          lat: 37.77 + i * 0.0001,
          lng: -122.42 - i * 0.0001,
          timestamp: Date.now(),
        }),
      );
      await sleep(15);
      await flushBatch();
    }

    const stats = getBandwidthStats();
    expect(stats.messagesSent).toBeGreaterThanOrEqual(2); // at least the full + one delta
    expect(stats.actualBytesSent).toBeLessThan(stats.fullPayloadEquivalentBytes);
    expect(stats.savingsPercent).toBeGreaterThan(0);

    driverClient.socket.terminate();
    subscriber.socket.terminate();
    await app.close();
  });
});
