import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, sleep } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import {
  notifyTripStatusChanged,
  getDriverSubscriberCount,
  getTripSubscriberCount,
} from "../src/ws/subscriptions";
import { flushBatch } from "../src/ws/location-batch";

async function makeOnlineDriver() {
  return createDriver({
    name: "Sub Driver",
    vehicleMake: "Honda",
    vehicleModel: "Civic",
    vehicleColor: "red",
    vehiclePlate: `SUB${Math.floor(Math.random() * 100000)}`,
    status: "online",
  });
}

async function makeTrip(riderId: string) {
  return requestTrip({
    riderId,
    pickup: { lat: 37.77, lng: -122.42 },
    dropoff: { lat: 37.8, lng: -122.27 },
  });
}

async function assignDriverToTrip(tripId: string, driverId: string): Promise<void> {
  await pool.query("UPDATE trips SET driver_id = $1 WHERE id = $2", [driverId, tripId]);
}

async function setTripStatus(tripId: string, status: string): Promise<void> {
  await pool.query("UPDATE trips SET status = $1 WHERE id = $2", [status, tripId]);
}

describe("ws-subscribe: /ws/subscribe", () => {
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

  it("subscribes by driverId and receives that driver's location broadcasts", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");

    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    const subAck = await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(subAck.driverId).toBe(driver.id);
    expect(getDriverSubscriberCount(driver.id)).toBe(1);

    driverClient.socket.send(JSON.stringify({ lat: 12, lng: 34, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch(); // background jobs are off in tests — flush the fleet-wide batch directly
    const locationMsg = await subscriber.waitForMessage((m) => m.type === "location");
    expect(locationMsg.driverId).toBe(driver.id);
    expect(locationMsg.lat).toBe(12);
    expect(locationMsg.lng).toBe(34);

    driverClient.socket.terminate();
    subscriber.socket.terminate();
    await app.close();
  });

  it("subscribes by tripId (driver already assigned) and receives that driver's broadcasts", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const rider = await createRider({ name: "Trip Rider" });
    const trip = await makeTrip(rider.id);
    await assignDriverToTrip(trip.id, driver.id);

    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");

    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", tripId: trip.id }));
    const subAck = await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(subAck.tripId).toBe(trip.id);
    expect(subAck.driverId).toBe(driver.id);

    driverClient.socket.send(JSON.stringify({ lat: 56, lng: 78, timestamp: Date.now() }));
    await sleep(20);
    await flushBatch();
    const locationMsg = await subscriber.waitForMessage((m) => m.type === "location");
    expect(locationMsg.driverId).toBe(driver.id);

    driverClient.socket.terminate();
    subscriber.socket.terminate();
    await app.close();
  });

  it("subscribes by tripId with no assigned driver yet without erroring", async () => {
    const app = makeWsApp();
    await app.ready();
    const rider = await createRider({ name: "Waiting Rider" });
    const trip = await makeTrip(rider.id);

    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", tripId: trip.id }));
    const subAck = await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(subAck.tripId).toBe(trip.id);
    expect(subAck.driverId).toBeNull();

    subscriber.socket.terminate();
    await app.close();
  });

  it("rejects subscribing to a trip that has already ended", async () => {
    const app = makeWsApp();
    await app.ready();
    const rider = await createRider({ name: "Ended Rider" });
    const trip = await makeTrip(rider.id);
    await setTripStatus(trip.id, "cancelled");

    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", tripId: trip.id }));
    const errorAck = await subscriber.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/already ended/);

    subscriber.socket.terminate();
    await app.close();
  });

  it("rejects subscribing to an unknown driverId/tripId", async () => {
    const app = makeWsApp();
    await app.ready();
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");

    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: uuidv4() }));
    const errorAck = await subscriber.waitForMessage((m) => m.type === "error");
    expect(errorAck.message).toMatch(/not found/);

    subscriber.socket.terminate();
    await app.close();
  });

  it("client-requested unsubscribe removes the subscription with no leak", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(getDriverSubscriberCount(driver.id)).toBe(1);

    subscriber.socket.send(JSON.stringify({ type: "unsubscribe" }));
    const unsubAck = await subscriber.waitForMessage((m) => m.type === "unsubscribed");
    expect(unsubAck.reason).toBe("client_requested");
    expect(getDriverSubscriberCount(driver.id)).toBe(0);

    subscriber.socket.terminate();
    await app.close();
  });

  it("socket close cleans up the subscription with no leak", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", driverId: driver.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(getDriverSubscriberCount(driver.id)).toBe(1);

    subscriber.socket.terminate();
    await sleep(50);
    expect(getDriverSubscriberCount(driver.id)).toBe(0);

    await app.close();
  });

  it("notifyTripStatusChanged cleanly unsubscribes trip subscribers on completion, no leak in either index", async () => {
    const app = makeWsApp();
    await app.ready();
    const driver = await makeOnlineDriver();
    const rider = await createRider({ name: "Completed Rider" });
    const trip = await makeTrip(rider.id);
    await assignDriverToTrip(trip.id, driver.id);

    const subscriber = await connectWs(app, "/ws/subscribe");
    await subscriber.waitForMessage((m) => m.type === "connected");
    subscriber.socket.send(JSON.stringify({ type: "subscribe", tripId: trip.id }));
    await subscriber.waitForMessage((m) => m.type === "subscribed");
    expect(getTripSubscriberCount(trip.id)).toBe(1);
    expect(getDriverSubscriberCount(driver.id)).toBe(1);

    // Stand-in for what Phase 6's matching/trip-completion flow will call once it exists (see
    // docs/websockets.md) — the mechanism itself is real and exercised here directly.
    notifyTripStatusChanged(trip.id, "completed");

    const unsubAck = await subscriber.waitForMessage((m) => m.type === "unsubscribed");
    expect(unsubAck.reason).toBe("trip_completed");
    expect(getTripSubscriberCount(trip.id)).toBe(0);
    expect(getDriverSubscriberCount(driver.id)).toBe(0);

    subscriber.socket.terminate();
    await app.close();
  });
});
