import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeApp } from "./helpers/app";
import { destinationPoint } from "./helpers/geo";
import { createDriver } from "../src/services/drivers.service";
import * as driverService from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import { configureEta } from "../src/services/eta-config";
import { handleDriverLocationUpdate, getTripEta } from "../src/services/eta.service";
import { getCachedEta } from "../src/repositories/eta.repository";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };

async function makeOnlineDriver() {
  return createDriver({
    name: "ETA Driver",
    vehicleMake: "Honda",
    vehicleModel: "Accord",
    vehicleColor: "black",
    vehiclePlate: `ETA${Math.floor(Math.random() * 1_000_000)}`,
    status: "online",
  });
}

async function makeMatchedTrip(driverId: string) {
  const rider = await createRider({ name: `Rider ${Math.floor(Math.random() * 1_000_000)}` });
  const trip = await requestTrip({ riderId: rider.id, pickup: PICKUP, dropoff: DROPOFF });
  await pool.query(
    "UPDATE trips SET driver_id = $1, status = 'matched', matched_at = now() WHERE id = $2",
    [driverId, trip.id],
  );
  return trip;
}

// One shared teardown for the whole file — pool/redis are module-level singletons shared across
// every describe block below, so closing them must happen exactly once, after everything.
afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("eta.service: throttled recompute", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("recomputes on the first update, skips a small move under the distance threshold, recomputes once the threshold is crossed", async () => {
    configureEta({
      mode: "heuristic", // explicit — see test/eta-ml-fallback.test.ts for why this can't be assumed
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 999_999_999, // effectively disabled — isolate the distance threshold
      recomputeDistanceMeters: 100,
      staleLocationMs: 999_999_999,
    });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);

    let t = 1_000_000;

    // 1st update: no cache exists yet, so this must recompute regardless of thresholds.
    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, t);
    const afterFirst = await getCachedEta(trip.id);
    expect(afterFirst).not.toBeNull();

    // 2nd update: ~10m away — well under the 100m threshold — must NOT recompute.
    const tinyMove = destinationPoint(PICKUP.lat, PICKUP.lng, 0, 10);
    t += 1_000;
    await handleDriverLocationUpdate(driver.id, tinyMove.lat, tinyMove.lng, t);
    const afterSecond = await getCachedEta(trip.id);
    expect(afterSecond!.computedAtMs).toBe(afterFirst!.computedAtMs); // unchanged: not recomputed

    // 3rd update: ~150m from the ORIGINAL cached position — crosses the 100m threshold.
    const bigMove = destinationPoint(PICKUP.lat, PICKUP.lng, 0, 150);
    t += 1_000;
    await handleDriverLocationUpdate(driver.id, bigMove.lat, bigMove.lng, t);
    const afterThird = await getCachedEta(trip.id);
    expect(afterThird!.computedAtMs).toBe(t); // recomputed, at this exact tick

    // Exactly 2 of the 3 location updates triggered a recompute — not every single tick.
    expect(afterFirst!.computedAtMs).not.toBe(afterThird!.computedAtMs);
  });

  it("recomputes based on the time threshold alone when the driver doesn't move", async () => {
    configureEta({
      mode: "heuristic", // explicit — see test/eta-ml-fallback.test.ts for why this can't be assumed
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 5_000,
      recomputeDistanceMeters: 999_999_999, // effectively disabled — isolate the time threshold
      staleLocationMs: 999_999_999,
    });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);

    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, 1_000);
    const first = await getCachedEta(trip.id);

    // +2s from the first compute — under the 5s threshold.
    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, 3_000);
    const second = await getCachedEta(trip.id);
    expect(second!.computedAtMs).toBe(first!.computedAtMs);

    // +5.5s from the first compute — crosses the 5s threshold.
    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, 6_500);
    const third = await getCachedEta(trip.id);
    expect(third!.computedAtMs).toBe(6_500);
  });

  it("a driver with no active trip triggers no recompute and does not throw", async () => {
    const driver = await makeOnlineDriver(); // no trip assigned
    await expect(
      handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, Date.now()),
    ).resolves.toBeUndefined();
  });
});

describe("eta.service: getTripEta edge cases", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      mode: "heuristic", // explicit — see test/eta-ml-fallback.test.ts for why this can't be assumed
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
    });
  });

  it("no driver assigned: a freshly requested trip returns a clear, distinct response — not a crash or nonsense number", async () => {
    const rider = await createRider({ name: "Waiting Rider" });
    const trip = await requestTrip({ riderId: rider.id, pickup: PICKUP, dropoff: DROPOFF });

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("no_driver_assigned");
    expect(result.etaSeconds).toBeNull();
    expect(result.distanceMeters).toBeNull();
  });

  it("trip completed: returns eta 0, not a stale leftover number", async () => {
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    // Prime a real cached (non-zero) ETA first, to prove completion overrides it rather than
    // just happening to return 0 because nothing was ever computed.
    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, Date.now());
    await pool.query("UPDATE trips SET status = 'completed', completed_at = now() WHERE id = $1", [
      trip.id,
    ]);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("trip_completed");
    expect(result.etaSeconds).toBe(0);
  });

  it("trip cancelled: returns a null eta, not 0 and not a stale number", async () => {
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await pool.query(
      "UPDATE trips SET status = 'cancelled', cancellation_reason = 'rider_cancelled' WHERE id = $1",
      [trip.id],
    );

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("trip_cancelled");
    expect(result.etaSeconds).toBeNull();
  });

  it("driver has no location data at all: flags staleness rather than fabricating a number", async () => {
    const driver = await makeOnlineDriver(); // status online, but updateDriverLocation never called
    const trip = await makeMatchedTrip(driver.id);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("stale_location");
    expect(result.etaSeconds).toBeNull();
    expect(result.driverLocationAgeMs).toBeNull();
  });

  it("driver location is stale: flags staleness but still surfaces the last known ETA, not a silently wrong current one", async () => {
    configureEta({
      mode: "heuristic", // explicit — see test/eta-ml-fallback.test.ts for why this can't be assumed
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 1_000, // tight threshold for the test
    });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat, PICKUP.lng);
    await handleDriverLocationUpdate(driver.id, PICKUP.lat, PICKUP.lng, Date.now());
    const primed = await getCachedEta(trip.id);
    expect(primed).not.toBeNull();

    // Backdate the driver's last update well beyond the 1s staleness threshold.
    await pool.query(
      "UPDATE drivers SET last_updated_at = now() - interval '10 minutes' WHERE id = $1",
      [driver.id],
    );

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("stale_location");
    expect(result.etaSeconds).toBe(primed!.etaSeconds); // last known value, not fabricated
    expect(result.driverLocationAgeMs).toBeGreaterThan(1_000);
  });

  it("ok case: fresh driver location produces a positive computed eta and distance", async () => {
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSeconds).toBeGreaterThan(0);
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.driverLocationAgeMs).not.toBeNull();
    expect(result.computedAt).not.toBeNull();
  });

  it("targets the dropoff instead of the pickup once the trip is in_progress", async () => {
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await pool.query("UPDATE trips SET status = 'in_progress', started_at = now() WHERE id = $1", [
      trip.id,
    ]);
    // Driver is now right at the pickup point (trip underway) — ETA should reflect the
    // remaining distance to DROPOFF, not the (now zero) distance to pickup.
    await driverService.updateDriverLocation(driver.id, PICKUP.lat, PICKUP.lng);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.distanceMeters).toBeGreaterThan(1_000); // roughly the pickup->dropoff distance
  });

  it("throws for an unknown trip id", async () => {
    await expect(getTripEta(uuidv4())).rejects.toThrow();
  });
});

describe("GET /trips/:id/eta (HTTP)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      mode: "heuristic", // explicit — see test/eta-ml-fallback.test.ts for why this can't be assumed
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
    });
  });

  it("returns status ok with a computed eta for a matched trip with a fresh driver location", async () => {
    const app = makeApp();
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const res = await app.inject({ method: "GET", url: `/trips/${trip.id}/eta` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.etaSeconds).toBeGreaterThan(0);

    await app.close();
  });

  it("returns status no_driver_assigned for a freshly requested trip", async () => {
    const app = makeApp();
    const rider = await createRider({ name: "HTTP Rider" });
    const trip = await requestTrip({ riderId: rider.id, pickup: PICKUP, dropoff: DROPOFF });

    const res = await app.inject({ method: "GET", url: `/trips/${trip.id}/eta` });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("no_driver_assigned");

    await app.close();
  });

  it("returns 404 for an unknown trip id", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `/trips/${uuidv4()}/eta` });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
