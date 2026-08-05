import { expect, test } from "@playwright/test";
import { createFakeDriver, type FakeDriverClient } from "./fakeDriverClient.js";

const CORE_URL = process.env.E2E_CORE_URL ?? "http://localhost:3011";
const CORE_WS_URL = process.env.E2E_CORE_WS_URL ?? "ws://localhost:3011";

/**
 * The one true end-to-end test this project has (Frontend Phase 9): a real browser, driving the
 * real rider request flow, against a real running `core` (real Postgres + Redis + WebSocket
 * server — see scripts/e2e-test.sh for how that stack comes up and gets torn down), matched to a
 * real scripted driver client (fakeDriverClient.ts — a real `ws` connection, not a mocked network
 * layer). Asserts on real rendered UI state throughout, not just "no console errors."
 */
test.describe("real rider request end to end", () => {
  let driver: FakeDriverClient | null = null;

  test.afterEach(async () => {
    driver?.close();
    driver = null;
  });

  test("a rider's request is matched by a real driver client, and the driver marker live-updates", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto("/");
    await page.waitForSelector("form");
    await page.fill('input[placeholder="Your name"]', "E2E Rider");
    await page.click('button:has-text("Continue")');
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    // Pick pickup/dropoff via real map clicks, then read back the REAL resulting coordinates —
    // simpler and more robust than back-calculating a pixel position for a target lat/lng, and
    // it's exactly what a real rider's tap produces.
    await page.locator(".leaflet-container").click({ position: { x: 640, y: 450 } });
    await page.waitForSelector('.leaflet-marker-icon[title="Pickup"]', { timeout: 5000 });
    const pickupText = (await page.locator("dd.font-mono").first().textContent()) ?? "";
    const [pickupLat, pickupLng] = pickupText.split(",").map((part) => parseFloat(part.trim()));
    expect(Number.isFinite(pickupLat)).toBe(true);
    expect(Number.isFinite(pickupLng)).toBe(true);

    await page.locator(".leaflet-container").click({ position: { x: 750, y: 350 } });
    await page.waitForSelector('.leaflet-marker-icon[title="Dropoff"]', { timeout: 5000 });

    // A real driver, positioned exactly at the rider's real chosen pickup point, so the real
    // matching search (docs/matching.md) genuinely finds it — not a coincidence of shared fixture
    // coordinates.
    driver = await createFakeDriver(CORE_URL, CORE_WS_URL, { lat: pickupLat, lng: pickupLng });

    await page.click('button:has-text("Request ride")');

    await expect(page.getByText("A driver has been matched and is heading your way.")).toBeVisible({
      timeout: 15_000,
    });

    // Per docs/websockets.md: subscribing to a matched trip does NOT get an immediate position
    // snapshot — only the driver's *next* location update does. The one update sent earlier (to
    // become discoverable for matching in the first place) predates the match itself, so the
    // marker genuinely doesn't exist on screen yet until a real post-match broadcast arrives.
    driver.sendLocation(pickupLat, pickupLng);

    const marker = page.locator('.leaflet-marker-icon[title="Driver"]');
    await expect(marker).toBeVisible({ timeout: 10_000 });
    const transformBefore = await marker.evaluate((el) => (el as HTMLElement).style.transform);
    expect(transformBefore).not.toBe("");

    // A real, subsequent location broadcast on the SAME live WS connection — the actual meaning
    // of "a live-updating driver marker": it moves because a new real message arrived, not
    // because of a one-time initial render.
    driver.sendLocation(pickupLat + 0.001, pickupLng + 0.0015);

    await expect
      .poll(async () => marker.evaluate((el) => (el as HTMLElement).style.transform), {
        timeout: 10_000,
        message: "driver marker's real screen position never changed after a real location broadcast",
      })
      .not.toBe(transformBefore);
  });
});
