import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeWsApp, resetWsForTests, connectWs, type WsClient } from "./helpers/ws";
import { createDriver } from "../src/services/drivers.service";
import * as driverService from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import * as driversRepo from "../src/repositories/drivers.repository";
import { matchTrip } from "../src/services/matching.service";
import { isDriverLockedForTests } from "../src/repositories/driver-lock.repository";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };
const NEARBY_OFFSET = 0.001; // ~110m — well inside the default 5km match search radius
const FAR_AWAY = { lat: 10, lng: 10 }; // nowhere near PICKUP or any seeded driver

async function makeReadyDriver(opts: {
  name: string;
  lat?: number;
  lng?: number;
  onlineForMs?: number;
}) {
  const driver = await createDriver({
    name: opts.name,
    vehicleMake: "Toyota",
    vehicleModel: "Corolla",
    vehicleColor: "blue",
    vehiclePlate: `MATCH${Math.floor(Math.random() * 1_000_000)}`,
    status: "online",
  });
  await driverService.updateDriverLocation(
    driver.id,
    opts.lat ?? PICKUP.lat + NEARBY_OFFSET,
    opts.lng ?? PICKUP.lng + NEARBY_OFFSET,
  );
  if (opts.onlineForMs !== undefined) {
    await redis.hset(`driver:${driver.id}:state`, "onlineSinceMs", Date.now() - opts.onlineForMs);
  }
  return driver;
}

async function makeTripNear(pickup: { lat: number; lng: number } = PICKUP) {
  const rider = await createRider({ name: `Rider ${Math.floor(Math.random() * 1_000_000)}` });
  return requestTrip({ riderId: rider.id, pickup, dropoff: DROPOFF });
}

function autoRespond(client: WsClient, accept: boolean): void {
  client.socket.on("message", (data) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed.type === "trip_offer") {
      client.socket.send(JSON.stringify({ type: "trip_response", tripId: parsed.tripId, accept }));
    }
  });
}

describe("matching.service: matchTrip", () => {
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

  it("successful match: assigns the driver, marks them busy, and notifies both parties", async () => {
    const app = makeWsApp();
    await app.ready();

    const driver = await makeReadyDriver({ name: "Accepting Driver" });
    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");
    autoRespond(driverClient, true);

    const trip = await makeTripNear();
    const riderSubscriber = await connectWs(app, "/ws/subscribe");
    await riderSubscriber.waitForMessage((m) => m.type === "connected");
    riderSubscriber.socket.send(JSON.stringify({ type: "subscribe", tripId: trip.id }));
    await riderSubscriber.waitForMessage((m) => m.type === "subscribed");

    const result = await matchTrip(trip.id);

    expect(result.outcome).toBe("matched");
    expect(result.trip.status).toBe("matched");
    expect(result.trip.driverId).toBe(driver.id);

    const updatedDriver = await driversRepo.findDriverById(driver.id);
    expect(updatedDriver?.status).toBe("busy");

    await driverClient.waitForMessage((m) => m.type === "trip_offer");
    await driverClient.waitForMessage((m) => m.type === "trip_matched");

    const matchedNotice = await riderSubscriber.waitForMessage((m) => m.type === "trip_matched");
    expect(matchedNotice.driverId).toBe(driver.id);

    driverClient.socket.terminate();
    riderSubscriber.socket.terminate();
    await app.close();
  });

  it("no drivers available: trip is cancelled with a distinct reason, not hung or silently failed", async () => {
    const app = makeWsApp();
    await app.ready();

    const trip = await makeTripNear(FAR_AWAY);
    const result = await matchTrip(trip.id);

    expect(result.outcome).toBe("no_drivers_available");
    expect(result.trip.status).toBe("cancelled");
    expect(result.trip.cancellationReason).toBe("no_drivers_available");

    await app.close();
  });

  it("all candidates declined: trip is cancelled with a distinct reason", async () => {
    const app = makeWsApp({ matching: { offerTimeoutMs: 150 } });
    await app.ready();

    const decliner = await makeReadyDriver({ name: "Declining Driver" });
    const declinerClient = await connectWs(app, `/ws/driver?driverId=${decliner.id}`);
    await declinerClient.waitForMessage((m) => m.type === "connected");
    autoRespond(declinerClient, false);

    const trip = await makeTripNear();
    const result = await matchTrip(trip.id);

    expect(result.outcome).toBe("all_candidates_declined");
    expect(result.trip.status).toBe("cancelled");
    expect(result.trip.cancellationReason).toBe("all_candidates_declined");

    const updatedDriver = await driversRepo.findDriverById(decliner.id);
    expect(updatedDriver?.status).toBe("online"); // never claimed, stays available

    declinerClient.socket.terminate();
    await app.close();
  });

  it("fallback on timeout: falls back to the next candidate when the top-scored driver never responds", async () => {
    const app = makeWsApp({ matching: { offerTimeoutMs: 150 } });
    await app.ready();

    // Silent driver is closer AND has been idle longer — guaranteed to score higher, so it's
    // tried first.
    const silentDriver = await makeReadyDriver({
      name: "Silent Driver",
      lat: PICKUP.lat + NEARBY_OFFSET * 0.1,
      lng: PICKUP.lng + NEARBY_OFFSET * 0.1,
      onlineForMs: 20 * 60_000,
    });
    const silentClient = await connectWs(app, `/ws/driver?driverId=${silentDriver.id}`);
    await silentClient.waitForMessage((m) => m.type === "connected");
    // No auto-respond attached — this driver receives the offer and never answers.

    const acceptingDriver = await makeReadyDriver({
      name: "Backup Driver",
      lat: PICKUP.lat + NEARBY_OFFSET * 5,
      lng: PICKUP.lng + NEARBY_OFFSET * 5,
      onlineForMs: 0,
    });
    const acceptingClient = await connectWs(app, `/ws/driver?driverId=${acceptingDriver.id}`);
    await acceptingClient.waitForMessage((m) => m.type === "connected");
    autoRespond(acceptingClient, true);

    const trip = await makeTripNear();
    const result = await matchTrip(trip.id);

    expect(result.outcome).toBe("matched");
    expect(result.trip.driverId).toBe(acceptingDriver.id);

    await silentClient.waitForMessage((m) => m.type === "trip_offer");
    const updatedSilentDriver = await driversRepo.findDriverById(silentDriver.id);
    expect(updatedSilentDriver?.status).toBe("online"); // timed out, never claimed

    const updatedAcceptingDriver = await driversRepo.findDriverById(acceptingDriver.id);
    expect(updatedAcceptingDriver?.status).toBe("busy");

    silentClient.socket.terminate();
    acceptingClient.socket.terminate();
    await app.close();
  });

  it("concurrency: two simultaneous trip requests near the same single driver — only one wins", async () => {
    const app = makeWsApp();
    await app.ready();

    const driver = await makeReadyDriver({ name: "Contested Driver" });
    const driverClient = await connectWs(app, `/ws/driver?driverId=${driver.id}`);
    await driverClient.waitForMessage((m) => m.type === "connected");
    autoRespond(driverClient, true);

    const [tripA, tripB] = await Promise.all([makeTripNear(), makeTripNear()]);

    const [resultA, resultB] = await Promise.all([matchTrip(tripA.id), matchTrip(tripB.id)]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["all_candidates_declined", "matched"]);

    const winner = resultA.outcome === "matched" ? resultA : resultB;
    const loser = resultA.outcome === "matched" ? resultB : resultA;
    expect(winner.trip.driverId).toBe(driver.id);
    expect(loser.trip.driverId).toBeNull();
    expect(loser.trip.cancellationReason).toBe("all_candidates_declined");

    // The driver ends up busy exactly once — no double booking.
    const updatedDriver = await driversRepo.findDriverById(driver.id);
    expect(updatedDriver?.status).toBe("busy");

    // Exactly one trip_offer was ever sent to this driver (the loser's lock acquisition failed
    // before it ever tried to send one).
    const offerCount = driverClient.messages.filter((m) => m.type === "trip_offer").length;
    expect(offerCount).toBe(1);

    // The lock is released after the flow completes either way — not left held forever.
    expect(await isDriverLockedForTests(driver.id)).toBe(false);

    driverClient.socket.terminate();
    await app.close();
  });
});
