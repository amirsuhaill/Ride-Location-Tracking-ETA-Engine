import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { resetDb } from "./helpers/db";
import { pool } from "../src/db";

describe("drivers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  const validDriverBody = {
    name: "Ada Lovelace",
    vehicleMake: "Toyota",
    vehicleModel: "Prius",
    vehicleColor: "blue",
    vehiclePlate: "ABC123",
  };

  it("POST /drivers creates a driver (happy path)", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/drivers", payload: validDriverBody });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTypeOf("string");
    expect(body.name).toBe(validDriverBody.name);
    expect(body.status).toBe("offline");
    expect(body.location).toBeNull();
    await app.close();
  });

  it("POST /drivers accepts an optional initial location", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: { ...validDriverBody, location: { lat: 37.77, lng: -122.42 } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.location.lat).toBeCloseTo(37.77, 5);
    expect(body.location.lng).toBeCloseTo(-122.42, 5);
    await app.close();
  });

  it("POST /drivers rejects a missing required field with 400", async () => {
    const app = makeApp();
    const payloadMissingName = {
      vehicleMake: validDriverBody.vehicleMake,
      vehicleModel: validDriverBody.vehicleModel,
      vehicleColor: validDriverBody.vehicleColor,
      vehiclePlate: validDriverBody.vehiclePlate,
    };
    const res = await app.inject({ method: "POST", url: "/drivers", payload: payloadMissingName });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("POST /drivers rejects out-of-range coordinates with 400", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: { ...validDriverBody, location: { lat: 200, lng: 0 } },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/lat/);
    await app.close();
  });

  it("GET /drivers/:id returns the driver", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: validDriverBody,
    });
    const id = created.json().id;

    const res = await app.inject({ method: "GET", url: `/drivers/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    await app.close();
  });

  it("GET /drivers/:id returns 404 for an unknown id", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/drivers/00000000-0000-0000-0000-000000000000",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("GET /drivers/:id returns 400 for a malformed id", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/drivers/not-a-uuid" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("PATCH /drivers/:id/status allows a legal transition (offline -> online)", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: validDriverBody,
    });
    const id = created.json().id;

    const res = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "online" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("online");
    await app.close();
  });

  it("PATCH /drivers/:id/status rejects an invalid status value with 400", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: validDriverBody,
    });
    const id = created.json().id;

    const res = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "on-a-break" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("PATCH /drivers/:id/status rejects an illegal transition (offline -> busy) with 409", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: validDriverBody,
    });
    const id = created.json().id;

    const res = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "busy" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    await app.close();
  });

  it("PATCH /drivers/:id/status rejects an illegal transition (busy -> offline) with 409", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/drivers",
      payload: validDriverBody,
    });
    const id = created.json().id;
    await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "online" },
    });
    await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "busy" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/drivers/${id}/status`,
      payload: { status: "offline" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    await app.close();
  });

  it("PATCH /drivers/:id/status returns 404 for an unknown driver", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/drivers/00000000-0000-0000-0000-000000000000/status",
      payload: { status: "online" },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
