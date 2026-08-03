import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers/app";
import { resetDb } from "./helpers/db";
import { resetRedis } from "./helpers/redis";
import { pool } from "../src/db";
import { redis } from "../src/redis";

const baseDriverBody = {
  name: "Nearby Nancy",
  vehicleMake: "Tesla",
  vehicleModel: "Model 3",
  vehicleColor: "white",
  vehiclePlate: "NEARBY1",
};

async function createOnlineDriver(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/drivers", payload: baseDriverBody });
  const id = created.json().id as string;
  await app.inject({
    method: "PATCH",
    url: `/drivers/${id}/status`,
    payload: { status: "online" },
  });
  return id;
}

describe("driver location + nearby (HTTP)", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRedis();
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("PATCH /drivers/:id/location updates Postgres and makes the driver appear in /drivers/nearby", async () => {
    const app = makeApp();
    const id = await createOnlineDriver(app);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/location`,
      payload: { lat: 37.7749, lng: -122.4194 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().location).toEqual({ lat: 37.7749, lng: -122.4194 });

    const nearbyRes = await app.inject({
      method: "GET",
      url: "/drivers/nearby?lat=37.7749&lng=-122.4194&radius=1000",
    });
    expect(nearbyRes.statusCode).toBe(200);
    const ids = nearbyRes.json().drivers.map((d: { driverId: string }) => d.driverId);
    expect(ids).toContain(id);

    await app.close();
  });

  it("PATCH /drivers/:id/location rejects out-of-range coordinates with 400", async () => {
    const app = makeApp();
    const id = await createOnlineDriver(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/location`,
      payload: { lat: 200, lng: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("PATCH /drivers/:id/location returns 404 for an unknown driver", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/drivers/00000000-0000-0000-0000-000000000000/location",
      payload: { lat: 37.7749, lng: -122.4194 },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /drivers/nearby excludes a driver once they're set busy", async () => {
    const app = makeApp();
    const id = await createOnlineDriver(app);
    await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/location`,
      payload: { lat: 37.7749, lng: -122.4194 },
    });

    await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "busy" },
    });

    const nearbyRes = await app.inject({
      method: "GET",
      url: "/drivers/nearby?lat=37.7749&lng=-122.4194&radius=1000",
    });
    const ids = nearbyRes.json().drivers.map((d: { driverId: string }) => d.driverId);
    expect(ids).not.toContain(id);

    await app.close();
  });

  it("GET /drivers/nearby rejects a radius over the max with 400", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/drivers/nearby?lat=37.7749&lng=-122.4194&radius=100000",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("GET /drivers/nearby rejects a limit over the max with 400", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/drivers/nearby?lat=37.7749&lng=-122.4194&limit=500",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("GET /drivers/nearby rejects missing lat/lng with 400", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/drivers/nearby" });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
