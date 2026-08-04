import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { createDriver } from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import { configureSurge } from "../src/services/surge-config";
import {
  computeAndUpdateSurge,
  getSurgeMultiplierForLocation,
} from "../src/services/surge.service";

// Far enough apart (~24km) to land in different zones at any realistic zone size this project
// would configure.
const ZONE_A = { lat: 37.7749, lng: -122.4194 };
const ZONE_B = { lat: 37.75, lng: -122.15 };

async function makeOnlineDriverAt(lat: number, lng: number) {
  return createDriver({
    name: "Surge Driver",
    vehicleMake: "Honda",
    vehicleModel: "Civic",
    vehicleColor: "gray",
    vehiclePlate: `SURGE${Math.floor(Math.random() * 1_000_000)}`,
    status: "online",
    location: { lat, lng },
  });
}

async function makeOpenTripRequestAt(pickup: { lat: number; lng: number }) {
  const rider = await createRider({ name: `Surge Rider ${Math.floor(Math.random() * 1_000_000)}` });
  return requestTrip({
    riderId: rider.id,
    pickup,
    dropoff: { lat: pickup.lat + 0.02, lng: pickup.lng + 0.02 },
  });
}

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

describe("surge.service: demand-spike scenario proves zone isolation", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureSurge({
      minSampleRequests: 3,
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
      // Unrestricted for this test — it's about the ratio/threshold logic reaching the right
      // target, not the smoothing cap (see the dedicated smoothing describe block below).
      maxChangePerInterval: 10,
    });
  });

  it("surge rises where demand spikes, while a separate, balanced zone stays at baseline — in the same run", async () => {
    // Zone A: a demand spike — 6 open requests, only 1 available driver.
    for (let i = 0; i < 6; i++) await makeOpenTripRequestAt(ZONE_A);
    await makeOnlineDriverAt(ZONE_A.lat, ZONE_A.lng);

    // Zone B: healthy supply relative to its (small) demand — must NOT be affected by zone A's
    // spike at all.
    await makeOpenTripRequestAt(ZONE_B);
    await makeOnlineDriverAt(ZONE_B.lat, ZONE_B.lng);
    await makeOnlineDriverAt(ZONE_B.lat, ZONE_B.lng);

    await computeAndUpdateSurge();

    const surgeA = await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng);
    const surgeB = await getSurgeMultiplierForLocation(ZONE_B.lat, ZONE_B.lng);

    expect(surgeA).toBeGreaterThan(1.0); // demand-spike zone: surge kicked in
    expect(surgeB).toBe(1.0); // unaffected zone: still exactly baseline
  });
});

describe("surge.service: documented floor/ceiling and minimum-sample-size rule", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureSurge({
      minSampleRequests: 3,
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
      maxChangePerInterval: 10, // isolate this from the smoothing cap, tested separately below
    });
  });

  it("a zone with 1 request and 0 drivers does not spike — stays at baseline (below the minimum sample size)", async () => {
    await makeOpenTripRequestAt(ZONE_A);
    // 0 drivers in this zone at all.

    await computeAndUpdateSurge();

    expect(await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng)).toBe(1.0);
  });

  it("a zone that clears the minimum sample but has an extreme ratio is capped at the documented ceiling, not left unbounded", async () => {
    for (let i = 0; i < 10; i++) await makeOpenTripRequestAt(ZONE_A); // 10 requests, 0 drivers -> raw ratio would be 10x

    await computeAndUpdateSurge();

    expect(await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng)).toBe(3.0); // the configured ceiling, not 10
  });

  it("a zone with abundant supply relative to demand never goes below the documented floor", async () => {
    await makeOpenTripRequestAt(ZONE_A);
    await makeOpenTripRequestAt(ZONE_A);
    await makeOpenTripRequestAt(ZONE_A);
    for (let i = 0; i < 20; i++) await makeOnlineDriverAt(ZONE_A.lat, ZONE_A.lng); // ratio 3/20 = 0.15

    await computeAndUpdateSurge();

    expect(await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng)).toBe(1.0); // floor, not a "discount" below it
  });
});

describe("surge.service: smoothing caps the max change per interval", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureSurge({
      minSampleRequests: 3,
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
      maxChangePerInterval: 0.2, // small, deliberate cap for this test
    });
  });

  it("does not jump straight to the target ratio in one interval — moves by at most the configured cap, then converges over several", async () => {
    for (let i = 0; i < 10; i++) await makeOpenTripRequestAt(ZONE_A); // target multiplier: 3.0 (the ceiling), starting from baseline 1.0

    await computeAndUpdateSurge();
    const afterFirst = await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng);
    expect(afterFirst).toBeCloseTo(1.2, 6); // baseline 1.0 + the 0.2 cap, not 3.0

    await computeAndUpdateSurge();
    const afterSecond = await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng);
    expect(afterSecond).toBeCloseTo(1.4, 6); // moved another 0.2 toward the target

    // Enough further intervals reach (and stay at) the true target — toBeCloseTo, not toBe,
    // since repeated floating-point addition of 0.2 can land a hair under 3.0 rather than
    // exactly on it.
    for (let i = 0; i < 20; i++) await computeAndUpdateSurge();
    expect(await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng)).toBeCloseTo(3.0, 6);
  });
});

describe("surge.service: does not recompute on every request — only when computeAndUpdateSurge() runs", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureSurge({
      minSampleRequests: 3,
      minMultiplier: 1.0,
      maxMultiplier: 3.0,
      maxChangePerInterval: 10,
    });
  });

  it("rapid-fire reads return the same cached multiplier even as the underlying demand changes, until the update interval actually runs", async () => {
    // 3 requests, 2 drivers -> ratio 1.5, comfortably below the 3.0 ceiling — leaves room for
    // the later recompute to genuinely rise further, not just re-hit an already-saturated cap.
    for (let i = 0; i < 3; i++) await makeOpenTripRequestAt(ZONE_A);
    await makeOnlineDriverAt(ZONE_A.lat, ZONE_A.lng);
    await makeOnlineDriverAt(ZONE_A.lat, ZONE_A.lng);
    await computeAndUpdateSurge();
    const initial = await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng);
    expect(initial).toBeGreaterThan(1.0);
    expect(initial).toBeLessThan(3.0);

    // A burst of new demand arrives, and a burst of reads happen — but without another
    // computeAndUpdateSurge() call, every read must keep returning the same stale-but-consistent
    // value, proving reads never trigger a recompute themselves.
    for (let i = 0; i < 10; i++) await makeOpenTripRequestAt(ZONE_A);
    for (let i = 0; i < 20; i++) {
      expect(await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng)).toBe(initial);
    }

    // Only once the interval actually fires does the new demand get reflected.
    await computeAndUpdateSurge();
    const afterRecompute = await getSurgeMultiplierForLocation(ZONE_A.lat, ZONE_A.lng);
    expect(afterRecompute).toBeGreaterThan(initial);
  });
});
