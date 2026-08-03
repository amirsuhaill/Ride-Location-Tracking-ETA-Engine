import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { resetDb } from "./helpers/db";
import { pool } from "../src/db";

describe("riders", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("POST /riders creates a rider (happy path)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/riders",
      payload: { name: "Grace Hopper" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTypeOf("string");
    expect(body.name).toBe("Grace Hopper");
    await app.close();
  });

  it("POST /riders rejects a missing name with 400", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/riders", payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("GET /riders/:id returns the rider", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/riders",
      payload: { name: "Grace Hopper" },
    });
    const id = created.json().id;

    const res = await app.inject({ method: "GET", url: `/riders/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    await app.close();
  });

  it("GET /riders/:id returns 404 for an unknown id", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/riders/00000000-0000-0000-0000-000000000000",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });
});
