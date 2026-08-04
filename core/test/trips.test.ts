import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers/app";
import { resetDb } from "./helpers/db";
import { pool } from "../src/db";

async function createRider(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/riders",
    payload: { name: "Grace Hopper" },
  });
  return res.json().id as string;
}

describe("trips", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  const validPickup = { lat: 37.7749, lng: -122.4194 };
  const validDropoff = { lat: 37.8044, lng: -122.2712 };

  it("POST /trips creates a requested trip (happy path)", async () => {
    const app = makeApp();
    const riderId = await createRider(app);

    const res = await app.inject({
      method: "POST",
      url: "/trips",
      payload: { riderId, pickup: validPickup, dropoff: validDropoff },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("requested");
    expect(body.riderId).toBe(riderId);
    expect(body.driverId).toBeNull();
    expect(body.pickup.lat).toBeCloseTo(validPickup.lat, 5);
    expect(body.pickup.lng).toBeCloseTo(validPickup.lng, 5);
    expect(body.dropoff.lat).toBeCloseTo(validDropoff.lat, 5);
    // Phase 13: a fresh fare quote is returned (not persisted) alongside the trip.
    expect(body.fareEstimate.currency).toBe("USD");
    expect(body.fareEstimate.totalCents).toBeGreaterThan(0);
    expect(body.fareEstimate.surgeMultiplier).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("POST /trips rejects malformed coordinates (lat=200) with 400", async () => {
    const app = makeApp();
    const riderId = await createRider(app);

    const res = await app.inject({
      method: "POST",
      url: "/trips",
      payload: { riderId, pickup: { lat: 200, lng: 0 }, dropoff: validDropoff },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/lat/);
    await app.close();
  });

  it("POST /trips returns 404 when riderId doesn't reference an existing rider", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/trips",
      payload: {
        riderId: "00000000-0000-0000-0000-000000000000",
        pickup: validPickup,
        dropoff: validDropoff,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("GET /trips/:id returns the trip", async () => {
    const app = makeApp();
    const riderId = await createRider(app);
    const created = await app.inject({
      method: "POST",
      url: "/trips",
      payload: { riderId, pickup: validPickup, dropoff: validDropoff },
    });
    const id = created.json().id;

    const res = await app.inject({ method: "GET", url: `/trips/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    await app.close();
  });

  it("GET /trips/:id returns 404 for an unknown id", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/trips/00000000-0000-0000-0000-000000000000",
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
