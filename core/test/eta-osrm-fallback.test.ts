import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { createDriver } from "../src/services/drivers.service";
import * as driverService from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import { configureEta } from "../src/services/eta-config";
import { getTripEta } from "../src/services/eta.service";
import {
  startOsrmStub,
  osrmOkHandler,
  osrmSlowHandler,
  osrmNoRouteHandler,
  osrmErrorStatusHandler,
  osrmMalformedHandler,
  type OsrmStub,
} from "./helpers/osrm-stub-server";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };

async function makeOnlineDriver() {
  return createDriver({
    name: "ETA OSRM Driver",
    vehicleMake: "Toyota",
    vehicleModel: "Camry",
    vehicleColor: "blue",
    vehiclePlate: `OSR${Math.floor(Math.random() * 1_000_000)}`,
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

let stub: OsrmStub | undefined;

afterAll(async () => {
  await pool.end();
  await redis.quit();
});

afterEach(async () => {
  // Safety net in case a test throws before reaching its own stub.close() — avoids leaking a
  // listening socket into the next test file (same convention as eta-ml-fallback.test.ts).
  if (stub) {
    await stub.close();
    stub = undefined;
  }
  configureEta({ mode: "heuristic", osrmEnabled: false });
});

describe("eta.service: OSRM integration — real road-network route vs haversine fallback (Phase 15)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 0,
      recomputeDistanceMeters: 0,
      staleLocationMs: 60_000,
      mode: "heuristic",
      osrmEnabled: true,
      osrmTimeoutMs: 150,
    });
  });

  it("uses OSRM's real route distance/duration when OSRM responds with a valid route", async () => {
    stub = await startOsrmStub(osrmOkHandler(2552.4, 368.5));
    configureEta({ osrmUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic_osrm");
    expect(result.distanceMeters).toBe(2552.4); // exactly OSRM's road distance, not haversine
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("falls back to haversine when OSRM is unreachable (connection refused)", async () => {
    const closedStub = await startOsrmStub(osrmOkHandler(2552.4, 368.5));
    const unreachableUrl = closedStub.url;
    await closedStub.close(); // nothing is listening at this URL anymore

    configureEta({ osrmUrl: unreachableUrl });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic"); // fell all the way back, not tagged as osrm
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("falls back to haversine when OSRM is reachable but too slow (exceeds the configured timeout)", async () => {
    stub = await startOsrmStub(osrmSlowHandler(2_000, 2552.4, 368.5)); // far beyond osrmTimeoutMs=150
    configureEta({ osrmUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const startedAtMs = Date.now();
    const result = await getTripEta(trip.id);
    const elapsedMs = Date.now() - startedAtMs;

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic");
    expect(result.etaSeconds).toBeGreaterThan(0);
    // Must actually have been aborted around ~150ms, not silently waited out for the full 2s the
    // stub takes to respond — proves this is a genuine timeout, not eventual success.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("falls back to haversine when OSRM returns a malformed response body", async () => {
    stub = await startOsrmStub(osrmMalformedHandler());
    configureEta({ osrmUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic");
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("falls back to haversine when OSRM returns a non-2xx, non-routing-failure error status", async () => {
    stub = await startOsrmStub(osrmErrorStatusHandler(500));
    configureEta({ osrmUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic");
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("falls back to haversine when OSRM explicitly reports no route (HTTP 400 + NoSegment/NoRoute code) — the real, verified OSRM contract, distinct from ml-service's convention", async () => {
    stub = await startOsrmStub(osrmNoRouteHandler("NoSegment"));
    configureEta({ osrmUrl: stub.url });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic"); // no_route is a failure mode like any other
    expect(result.etaSeconds).toBeGreaterThan(0);
  });

  it("does not call OSRM at all when ETA_OSRM_ENABLED is off — plain haversine, unchanged from pre-Phase-15 behavior", async () => {
    let called = false;
    stub = await startOsrmStub((req, res) => {
      called = true;
      osrmOkHandler(2552.4, 368.5)(req, res);
    });
    configureEta({ osrmUrl: stub.url, osrmEnabled: false });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("heuristic");
    expect(called).toBe(false);
  });
});

describe("eta.service: OSRM feeds ml_with_fallback's fallback branch too, not just plain heuristic mode", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  it("uses OSRM's real distance for the ml_with_fallback fallback (still tagged ml_fallback, per the existing EtaSource contract)", async () => {
    stub = await startOsrmStub(osrmOkHandler(2552.4, 368.5));
    configureEta({
      avgSpeedMetersPerSecond: 10,
      recomputeIntervalMs: 0,
      recomputeDistanceMeters: 0,
      staleLocationMs: 60_000,
      mode: "ml_with_fallback",
      mlServiceUrl: "http://127.0.0.1:1", // guaranteed unreachable — forces the fallback branch
      mlTimeoutMs: 150,
      mlCacheTtlMs: 0,
      osrmEnabled: true,
      osrmUrl: stub.url,
      osrmTimeoutMs: 150,
    });

    const driver = await makeOnlineDriver();
    const trip = await makeMatchedTrip(driver.id);
    await driverService.updateDriverLocation(driver.id, PICKUP.lat + 0.01, PICKUP.lng + 0.01);

    const result = await getTripEta(trip.id);

    expect(result.status).toBe("ok");
    expect(result.etaSource).toBe("ml_fallback");
    expect(result.distanceMeters).toBe(2552.4); // OSRM's real distance powered this fallback
  });
});
