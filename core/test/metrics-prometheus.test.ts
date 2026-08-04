import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { makeApp } from "./helpers/app";
import { createDriver } from "../src/services/drivers.service";
import { createRider } from "../src/services/riders.service";
import { requestTrip } from "../src/services/trips.service";
import { matchTrip } from "../src/services/matching.service";
import { enqueueLocationUpdate, flushBatch, resetLocationBatchForTests } from "../src/ws/location-batch";

const PICKUP = { lat: 37.7749, lng: -122.4194 };
const DROPOFF = { lat: 37.8044, lng: -122.2712 };

function extractCounterValue(body: string, metricName: string): number | null {
  // Prometheus text exposition: "metric_name{labels} value" or "metric_name value", one per line,
  // possibly with label sets — matches the bare (no-label) series specifically.
  const line = body.split("\n").find((l) => l.startsWith(`${metricName} `));
  if (!line) return null;
  const value = Number(line.split(" ")[1]);
  return Number.isFinite(value) ? value : null;
}

describe("GET /internal/metrics/prometheus", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
    resetLocationBatchForTests();
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("returns 200, Prometheus text content-type, and every declared metric name", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/internal/metrics/prometheus" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const body = res.body;
    for (const metricName of [
      "location_updates_processed_total",
      "location_broadcast_latency_seconds",
      "trip_matching_latency_seconds",
      "event_loop_lag_ms",
      "pg_pool_connections",
      "ws_fleet_size",
      "ws_bandwidth_bytes",
    ]) {
      expect(body).toContain(`# HELP ${metricName}`);
      expect(body).toContain(`# TYPE ${metricName}`);
    }

    await app.close();
  });

  it("location_updates_processed_total increases by exactly the number of real updates enqueued", async () => {
    const app = makeApp();
    const before = extractCounterValue(
      (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" })).body,
      "location_updates_processed_total",
    );

    const driver = await createDriver({
      name: "Metrics Driver",
      vehicleMake: "Kia",
      vehicleModel: "Soul",
      vehicleColor: "green",
      vehiclePlate: `MET${Math.floor(Math.random() * 1_000_000)}`,
      status: "online",
    });
    enqueueLocationUpdate(driver.id, { lat: PICKUP.lat, lng: PICKUP.lng, timestamp: Date.now() });
    enqueueLocationUpdate(driver.id, { lat: PICKUP.lat, lng: PICKUP.lng, timestamp: Date.now() });
    await flushBatch();

    const after = extractCounterValue(
      (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" })).body,
      "location_updates_processed_total",
    );

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect((after as number) - (before as number)).toBe(2);

    await app.close();
  });

  it("location_broadcast_latency_seconds records a real observation on flush", async () => {
    const app = makeApp();
    const beforeBody = (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" }))
      .body;
    const beforeCount = extractCounterValue(beforeBody, "location_broadcast_latency_seconds_count");

    const driver = await createDriver({
      name: "Metrics Broadcast Driver",
      vehicleMake: "Kia",
      vehicleModel: "Rio",
      vehicleColor: "red",
      vehiclePlate: `BRO${Math.floor(Math.random() * 1_000_000)}`,
      status: "online",
    });
    enqueueLocationUpdate(driver.id, { lat: PICKUP.lat, lng: PICKUP.lng, timestamp: Date.now() });
    await flushBatch();

    const afterBody = (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" }))
      .body;
    const afterCount = extractCounterValue(afterBody, "location_broadcast_latency_seconds_count");

    expect((afterCount as number) - (beforeCount ?? 0)).toBe(1);

    await app.close();
  });

  it("trip_matching_latency_seconds records a real observation for a real matchTrip() call", async () => {
    const app = makeApp();
    const beforeBody = (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" }))
      .body;
    const beforeCount = extractCounterValue(beforeBody, "trip_matching_latency_seconds_count");

    // No online drivers seeded — resolves fast via the no_drivers_available path, still a real
    // matching attempt that the histogram must observe (see matching.service.ts's finally block).
    const rider = await createRider({ name: "Metrics Rider" });
    const trip = await requestTrip({ riderId: rider.id, pickup: PICKUP, dropoff: DROPOFF });
    const result = await matchTrip(trip.id);
    expect(result.outcome).toBe("no_drivers_available");

    const afterBody = (await app.inject({ method: "GET", url: "/internal/metrics/prometheus" }))
      .body;
    const afterCount = extractCounterValue(afterBody, "trip_matching_latency_seconds_count");

    expect((afterCount as number) - (beforeCount ?? 0)).toBe(1);

    await app.close();
  });
});
