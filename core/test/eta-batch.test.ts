import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { createDriver } from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import { findActiveTripsForDrivers } from "../src/repositories/trips.repository";
import { configureEta } from "../src/services/eta-config";
import {
  handleDriverLocationUpdate,
  handleDriverLocationUpdatesBatch,
} from "../src/services/eta.service";
import { getCachedEta } from "../src/repositories/eta.repository";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };

async function makeOnlineDriver(name: string) {
  return createDriver({
    name,
    vehicleMake: "Honda",
    vehicleModel: "Accord",
    vehicleColor: "black",
    vehiclePlate: `BATCH${Math.floor(Math.random() * 1_000_000)}`,
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

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("trips.repository: findActiveTripsForDrivers (batched, Phase 11)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("returns an empty map for an empty input, without querying", async () => {
    const result = await findActiveTripsForDrivers([]);
    expect(result.size).toBe(0);
  });

  it("returns only drivers with a matched/in_progress trip, in one query, excluding everyone else", async () => {
    const matchedDriver = await makeOnlineDriver("Matched Driver");
    const matchedTrip = await makeMatchedTrip(matchedDriver.id);

    const idleDriver = await makeOnlineDriver("Idle Driver"); // no trip at all

    const cancelledDriver = await makeOnlineDriver("Cancelled-trip Driver");
    const rider = await createRider({ name: "Some Rider" });
    const cancelledTrip = await requestTrip({
      riderId: rider.id,
      pickup: PICKUP,
      dropoff: DROPOFF,
    });
    // A driver_id can persist on a trip that later moved to a non-active status (e.g. cancelled
    // after being matched) — the status filter, not just "has a driver_id", must be what excludes it.
    await pool.query(
      "UPDATE trips SET driver_id = $1, status = 'cancelled', cancellation_reason = 'rider_cancelled' WHERE id = $2",
      [cancelledDriver.id, cancelledTrip.id],
    );

    const result = await findActiveTripsForDrivers([
      matchedDriver.id,
      idleDriver.id,
      cancelledDriver.id,
    ]);

    expect(result.size).toBe(1);
    expect(result.get(matchedDriver.id)?.id).toBe(matchedTrip.id);
    expect(result.has(idleDriver.id)).toBe(false);
    expect(result.has(cancelledDriver.id)).toBe(false);
  });
});

describe("eta.service: handleDriverLocationUpdatesBatch matches the per-driver equivalent (Phase 11)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      mode: "heuristic",
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 0,
      recomputeDistanceMeters: 0,
      staleLocationMs: 60_000,
    });
  });

  it("is a no-op for an empty batch", async () => {
    await expect(handleDriverLocationUpdatesBatch([])).resolves.toBeUndefined();
  });

  it("recomputes ETA only for drivers with an active trip, leaving idle drivers untouched", async () => {
    const matchedDriver = await makeOnlineDriver("Matched Driver");
    const trip = await makeMatchedTrip(matchedDriver.id);
    const idleDriver = await makeOnlineDriver("Idle Driver");

    // Offset from PICKUP (the matched trip's target) so the resulting ETA is a real positive
    // number, not a same-point 0.
    await handleDriverLocationUpdatesBatch([
      {
        driverId: matchedDriver.id,
        lat: PICKUP.lat + 0.01,
        lng: PICKUP.lng + 0.01,
        timestampMs: 1_000,
      },
      { driverId: idleDriver.id, lat: PICKUP.lat, lng: PICKUP.lng, timestampMs: 1_000 },
    ]);

    const cached = await getCachedEta(trip.id);
    expect(cached).not.toBeNull();
    expect(cached!.etaSeconds).toBeGreaterThan(0);
  });

  it("produces the same cached ETA as calling handleDriverLocationUpdate once per driver", async () => {
    const driverA = await makeOnlineDriver("Driver A");
    const tripA = await makeMatchedTrip(driverA.id);
    const driverB = await makeOnlineDriver("Driver B");
    const tripB = await makeMatchedTrip(driverB.id);

    // Reference: one-call-per-driver (the pre-Phase-11 behavior).
    await handleDriverLocationUpdate(driverA.id, PICKUP.lat + 0.001, PICKUP.lng, 5_000);
    await handleDriverLocationUpdate(driverB.id, PICKUP.lat, PICKUP.lng + 0.001, 5_000);
    const referenceA = await getCachedEta(tripA.id);
    const referenceB = await getCachedEta(tripB.id);

    await resetDb();
    await resetRedis();
    // Recreate the same two matched trips fresh, then use the batched path instead.
    const driverA2 = await makeOnlineDriver("Driver A");
    const tripA2 = await makeMatchedTrip(driverA2.id);
    const driverB2 = await makeOnlineDriver("Driver B");
    const tripB2 = await makeMatchedTrip(driverB2.id);

    await handleDriverLocationUpdatesBatch([
      { driverId: driverA2.id, lat: PICKUP.lat + 0.001, lng: PICKUP.lng, timestampMs: 5_000 },
      { driverId: driverB2.id, lat: PICKUP.lat, lng: PICKUP.lng + 0.001, timestampMs: 5_000 },
    ]);
    const batchedA = await getCachedEta(tripA2.id);
    const batchedB = await getCachedEta(tripB2.id);

    expect(batchedA!.etaSeconds).toBeCloseTo(referenceA!.etaSeconds, 6);
    expect(batchedB!.etaSeconds).toBeCloseTo(referenceB!.etaSeconds, 6);
  });
});
