import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { getTripEta } from "../src/services/eta.service";
import {
  startMlStub,
  mlOkHandler,
  mlSlowHandler,
  mlErrorStatusHandler,
  mlMalformedHandler,
  type MlStub,
} from "./helpers/ml-stub-server";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };

async function makeOnlineDriver() {
  return createDriver({
    name: "ETA ML Driver",
    vehicleMake: "Honda",
    vehicleModel: "Accord",
    vehicleColor: "black",
    vehiclePlate: `MLE${Math.floor(Math.random() * 1_000_000)}`,
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

let stub: MlStub | undefined;

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

afterEach(async () => {
  // Safety net in case a test throws before reaching its own stub.close() — avoids leaking a
  // listening socket into the next test file.
  if (stub) {
    await stub.close();
    stub = undefined;
  }
  // configureEta merges into a shared module-level singleton (see eta-config.ts) — reset mode
  // back to the default so a leftover "ml"/"ml_with_fallback" (plus a now-closed stub's
  // mlServiceUrl) never leaks into whichever test file runs next.
  configureEta({ mode: "heuristic" });
});

describe("eta.service: ML integration — three distinct failure modes (mode=ml_with_fallback)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
      mode: "ml_with_fallback",
      mlTimeoutMs: 150,
      mlCacheTtlMs: 5_000,
    });
  });

  it("falls back to the heuristic when ml-service is unreachable (connection refused)", async () => {
    const closedStub = await startMlStub(mlOkHandler(999, 5000));
    const unreachableUrl = closedStub.url;
    await closedStub.close(); // nothing is listening at this URL anymore

    configureEta({ mlServiceUrl: unreachableUrl });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("ml_fallback");
    expect(result.servedFromCache).toBe(false);
    expect(result.etaSeconds).toBeGreaterThan(0); // the heuristic still produced a real number
  });

  it("falls back to the heuristic when ml-service is reachable but too slow (exceeds the configured timeout)", async () => {
    stub = await startMlStub(mlSlowHandler(2_000, 999, 5000)); // far beyond mlTimeoutMs=150
    configureEta({ mlServiceUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const startedAtMs = Date.now();
    const result = await getTripEta(trip.id);
    const elapsedMs = Date.now() - startedAtMs;

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("ml_fallback");
    expect(result.etaSeconds).toBeGreaterThan(0);
    // The request must actually have been aborted around ~150ms, not silently waited out for the
    // full 2s the stub takes to respond — proves this is a genuine timeout, not eventual success.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("falls back to the heuristic when ml-service returns a malformed response body", async () => {
    stub = await startMlStub(mlMalformedHandler());
    configureEta({ mlServiceUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("ml_fallback");
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("falls back to the heuristic when ml-service returns a non-2xx error status", async () => {
    stub = await startMlStub(mlErrorStatusHandler(500));
    configureEta({ mlServiceUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("ml_fallback");
    expect(result.etaSeconds).toBeGreaterThan(0);
  });
});

describe("eta.service: mode='ml' (no fallback) surfaces ML failure distinctly", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
      mode: "ml",
      mlTimeoutMs: 150,
      mlCacheTtlMs: 5_000,
    });
  });

  it("returns ml_unavailable (not a silent heuristic fallback) when ML fails and nothing is cached", async () => {
    stub = await startMlStub(mlErrorStatusHandler(500));
    configureEta({ mlServiceUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ml_unavailable");
    expect(result.etaSeconds).toBeNull(); // nothing was ever cached to degrade to
    expect(result.etaSource).toBeNull();

    await stub.close();
    stub = undefined;
  });

  it("degrades to the last cached ML value (still flagged ml_unavailable) rather than a fresh heuristic number", async () => {
    // First call: ML succeeds, gets cached.
    stub = await startMlStub(mlOkHandler(321, 1500));
    configureEta({ mlServiceUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const first = await getTripEta(trip.id);
    expect(first.status).toBe("ok");
    expect(first.etaSource).toBe("ml");
    expect(first.etaSeconds).toBe(321);
    await stub.close();
    stub = undefined;

    // Second call, past the ML cache TTL and after a real move (forces a recompute attempt):
    // ML is now down, mode="ml" has no fallback, so the prior ML value degrades through rather
    // than being silently replaced by a heuristic number.
    configureEta({ mlCacheTtlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bigMove = destinationPoint(PICKUP.lat, PICKUP.lng, 0, 300);
    await driverService.updateDriverLocation(driver.id, bigMove.lat, bigMove.lng);

    const second = await getTripEta(trip.id);
    expect(second.status).toBe("ml_unavailable");
    expect(second.etaSource).toBe("ml"); // still tagged with the engine that produced this number
    expect(second.etaSeconds).toBe(321); // the stale-but-real ML value, not a fresh heuristic one
    stub = undefined;
  });
});

describe("eta.service: ETA_MODE toggle changes observable behavior for the same trip", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("heuristic / ml / ml_with_fallback produce three different etaSource values for an identical request", async () => {
    stub = await startMlStub(mlOkHandler(777, 4200));

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 0,
      recomputeDistanceMeters: 0,
      staleLocationMs: 60_000,
      mlCacheTtlMs: 0,
      mlTimeoutMs: 150,
      mlServiceUrl: stub.url,
      mode: "heuristic",
    });
    const heuristicResult = await getTripEta(trip.id);
    expect(heuristicResult.etaSource).toBe("heuristic");
    expect(heuristicResult.etaSeconds).not.toBe(777); // never touched the ML stub at all

    configureEta({ mode: "ml" });
    const mlResult = await getTripEta(trip.id);
    expect(mlResult.etaSource).toBe("ml");
    expect(mlResult.etaSeconds).toBe(777); // the exact value the stub returned

    configureEta({ mode: "ml_with_fallback" });
    const fallbackResult = await getTripEta(trip.id);
    expect(fallbackResult.etaSource).toBe("ml"); // ML is healthy, so no fallback needed here
    expect(fallbackResult.etaSeconds).toBe(777);

    await stub.close();
    stub = undefined;
  });
});

describe("eta.service: ML cache TTL throttles repeated ML calls (reuses the Phase 7 throttle, doesn't duplicate it)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("does not call ml-service again within mlCacheTtlMs for a small movement, but does after it elapses or a big move happens", async () => {
    let callCount = 0;
    stub = await startMlStub((req, res) => {
      callCount++;
      mlOkHandler(500, 4000)(req, res);
    });

    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 999_999_999,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
      mode: "ml",
      mlServiceUrl: stub.url,
      mlTimeoutMs: 150,
      mlCacheTtlMs: 200,
    });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);

    await driverService.updateDriverLocation(driver.id, PICKUP.lat, PICKUP.lng);
    await getTripEta(trip.id);
    expect(callCount).toBe(1);

    // Immediately again, tiny/no movement, well within the 200ms TTL — must NOT call ML again.
    await getTripEta(trip.id);
    expect(callCount).toBe(1);

    // A move well past the 200m distance threshold — must trigger a fresh ML call even though
    // the time-based TTL hasn't elapsed yet.
    const bigMove = destinationPoint(PICKUP.lat, PICKUP.lng, 0, 300);
    await driverService.updateDriverLocation(driver.id, bigMove.lat, bigMove.lng);
    await getTripEta(trip.id);
    expect(callCount).toBe(2);

    // After the TTL elapses, even with no movement, a fresh call is made again.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await getTripEta(trip.id);
    expect(callCount).toBe(3);

    await stub.close();
    stub = undefined;
  });
});

describe("GET /trips/:id/eta (HTTP): exposes eta source via response headers", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("sets X-ETA-Source and X-ETA-Cache headers matching the response body", async () => {
    stub = await startMlStub(mlOkHandler(888, 6000));
    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 15_000,
      recomputeDistanceMeters: 200,
      staleLocationMs: 60_000,
      mode: "ml",
      mlServiceUrl: stub.url,
      mlTimeoutMs: 150,
      mlCacheTtlMs: 15_000,
    });

    const app = makeApp();
    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const first = await app.inject({ method: "GET", url: `/trips/${trip.id}/eta` });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-eta-source"]).toBe("ml");
    expect(first.headers["x-eta-cache"]).toBe("miss");
    expect(first.json().etaSource).toBe("ml");

    const second = await app.inject({ method: "GET", url: `/trips/${trip.id}/eta` });
    expect(second.headers["x-eta-source"]).toBe("ml");
    expect(second.headers["x-eta-cache"]).toBe("hit"); // within mlCacheTtlMs, no fresh call

    await app.close();
    await stub.close();
    stub = undefined;
  });
});
