import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { makeApp } from "./helpers/app";

// A browser-based frontend on a different origin (the whole point of Phase 0's frontend work) is
// blocked by the browser's own same-origin policy unless core explicitly opts it in via CORS
// headers — this is a real, previously-missing requirement, not a hypothetical, discovered by
// actually running a browser against a locally-served frontend and watching the health check
// hang (see docs/frontend-shell.md).
describe("CORS (config.corsOrigins, default http://localhost:5173)", () => {
  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("echoes back an allowed origin's Access-Control-Allow-Origin header", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:5173" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    await app.close();
  });

  it("does not grant CORS access to an origin outside the allowlist", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://evil.example.com" },
    });

    // The request still succeeds server-side (this isn't authentication) — the actual
    // enforcement happens in the requesting browser, which refuses to expose the response to
    // the calling page's script when this header is absent for its origin.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("answers a real CORS preflight (OPTIONS) request for a POST route", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/trips",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");

    await app.close();
  });

  // @fastify/cors defaults `methods` to `GET,HEAD,POST` only — PATCH was silently unusable
  // cross-origin until this was caught live (Frontend Phase 4's driver status toggle was the
  // first real cross-origin PATCH request anywhere in this project). This test exists
  // specifically so that regression can never come back unnoticed.
  it("answers a real CORS preflight (OPTIONS) request for a PATCH route", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/drivers/00000000-0000-0000-0000-000000000000/status",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");

    await app.close();
  });
});
