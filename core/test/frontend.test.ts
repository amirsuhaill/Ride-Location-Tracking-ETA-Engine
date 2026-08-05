import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { redis } from "../src/redis";
import { buildServer } from "../src/server";

function makeFakeFrontendDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ride-tracking-frontend-test-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>fake app</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('fake bundle');");
  return dir;
}

describe("routes/frontend: serving the built frontend from core (Frontend Phase 10)", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it("is a real no-op when the configured dist path doesn't exist — never affects normal dev/test behavior", async () => {
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: { distPath: path.join(tmpdir(), "definitely-does-not-exist-anywhere") },
    });

    const res = await app.inject({ method: "GET", url: "/" });
    // No frontend served -> Fastify's own plain default 404, not index.html.
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("fake app");

    await app.close();
  });

  it("serves the real built index.html and real static assets from the configured dist path", async () => {
    tmpDir = makeFakeFrontendDist();
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: { distPath: tmpDir },
    });

    const indexRes = await app.inject({ method: "GET", url: "/" });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.body).toContain("fake app");

    const assetRes = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.body).toContain("fake bundle");

    await app.close();
  });

  it("falls back to index.html for a client-side route with no matching file (SPA fallback)", async () => {
    tmpDir = makeFakeFrontendDist();
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: { distPath: tmpDir },
    });

    // /driver has no file on disk — a real react-router client-side route, reached here the same
    // way a direct browser navigation/reload to it would.
    const res = await app.inject({ method: "GET", url: "/driver" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("fake app");
    expect(res.headers["content-type"]).toContain("text/html");

    await app.close();
  });

  it("a genuinely missing API path still gets this project's own real error shape, not index.html", async () => {
    tmpDir = makeFakeFrontendDist();
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: { distPath: tmpDir },
    });

    const res = await app.inject({ method: "GET", url: "/drivers/nested/path/matching/no/real/route" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(res.body).not.toContain("fake app");

    await app.close();
  });

  it("/runtime-config.js derives coreApiUrl/coreWsUrl from the real request's Host header when unset", async () => {
    tmpDir = makeFakeFrontendDist();
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: { distPath: tmpDir, publicCoreApiUrl: "", publicCoreWsUrl: "" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/runtime-config.js",
      headers: { host: "example.test:3000" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.body).toContain('"coreApiUrl":"http://example.test:3000"');
    expect(res.body).toContain('"coreWsUrl":"ws://example.test:3000"');

    await app.close();
  });

  it("/runtime-config.js uses an explicit override instead — the real proof one built frontend can point at a different backend without a rebuild", async () => {
    tmpDir = makeFakeFrontendDist();
    const app = buildServer({
      logger: false,
      startBackgroundJobs: false,
      frontend: {
        distPath: tmpDir,
        publicCoreApiUrl: "http://a-totally-different-backend.example:9000",
        publicCoreWsUrl: "ws://a-totally-different-backend.example:9000",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/runtime-config.js",
      headers: { host: "this-origin-is-irrelevant.test" },
    });

    expect(res.body).toContain('"coreApiUrl":"http://a-totally-different-backend.example:9000"');
    expect(res.body).toContain('"coreWsUrl":"ws://a-totally-different-backend.example:9000"');
    expect(res.body).not.toContain("this-origin-is-irrelevant");

    await app.close();
  });
});
