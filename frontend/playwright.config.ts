import { defineConfig } from "@playwright/test";

/**
 * The real end-to-end suite (Frontend Phase 9) — a genuinely separate test run from `npm test`
 * (Vitest's fast, in-process unit/component suite). This one drives a real browser against a
 * real running `core` (real Postgres + Redis, real WebSocket connections), so it's invoked via
 * `npm run test:e2e` (scripts/e2e-test.sh), which brings that whole disposable stack up first and
 * tears it down after — never run directly with bare `npx playwright test` unless you've already
 * started a matching backend yourself and export E2E_APP_URL/E2E_CORE_URL/E2E_CORE_WS_URL to
 * point at it (see e2e/README.md).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_APP_URL ?? "http://localhost:5181",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
