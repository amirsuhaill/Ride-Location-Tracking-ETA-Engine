/**
 * Standalone throttle verification script — NOT part of the automated test suite.
 *
 * Connects to a REAL running core service (start one with `npm run dev` or `make up` first),
 * creates a scratch driver, simulates that driver sending a location update every 200ms for a
 * fixed window, and counts how many broadcast messages a subscriber actually receives over that
 * window. Asserts the count matches the configured throttle rate (~1/sec by default) and prints
 * the measured numbers — this is the "don't eyeball logs" requirement from the Phase 4 spec.
 *
 * Usage:
 *   CORE_HTTP_URL=http://localhost:3000 CORE_WS_URL=ws://localhost:3000 npx tsx scripts/ws-throttle-client.ts
 * (both env vars default to localhost:3000 if omitted)
 */
import WebSocket from "ws";

const HTTP_URL = process.env.CORE_HTTP_URL ?? "http://localhost:3000";
const WS_URL = process.env.CORE_WS_URL ?? "ws://localhost:3000";

const SEND_INTERVAL_MS = 200;
const TEST_DURATION_MS = 5_000;
// Must match the server's WS_DRIVER_THROTTLE_MS (default 1000ms) for the expected-count math
// below to hold; override via env if you've configured the server differently.
const EXPECTED_THROTTLE_MS = Number(process.env.WS_DRIVER_THROTTLE_MS ?? 1000);

async function createScratchDriver(): Promise<string> {
  const res = await fetch(`${HTTP_URL}/drivers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Throttle Test Driver",
      vehicleMake: "Test",
      vehicleModel: "Script",
      vehicleColor: "n/a",
      vehiclePlate: `THR${Date.now()}`,
      status: "online",
    }),
  });
  if (!res.ok) {
    throw new Error(`failed to create scratch driver: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForMessage(
  socket: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching message`));
    }, timeoutMs);

    function onMessage(data: WebSocket.RawData): void {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(parsed)) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(parsed);
      }
    }

    socket.on("message", onMessage);
  });
}

async function main(): Promise<void> {
  console.log(`Creating scratch driver via ${HTTP_URL} ...`);
  const driverId = await createScratchDriver();
  console.log(`Driver created: ${driverId}`);

  const driverSocket = new WebSocket(`${WS_URL}/ws/driver?driverId=${driverId}`);
  await waitForOpen(driverSocket);
  await waitForMessage(driverSocket, (m) => m.type === "connected");
  console.log("Driver socket connected.");

  const subscriberSocket = new WebSocket(`${WS_URL}/ws/subscribe`);
  await waitForOpen(subscriberSocket);
  await waitForMessage(subscriberSocket, (m) => m.type === "connected");
  subscriberSocket.send(JSON.stringify({ type: "subscribe", driverId }));
  await waitForMessage(subscriberSocket, (m) => m.type === "subscribed");
  console.log(`Subscriber subscribed to driver ${driverId}.`);

  // Phase 5 added delta compression on top of Phase 4's throttling: only the first broadcast to
  // this subscriber is a full "location" message, the rest are "delta" messages carrying
  // quantized lat/lng offsets — decode the chain to track the true reconstructed position.
  const QUANTIZATION_STEP_DEGREES = 1e-5;
  let receivedCount = 0;
  let lastKnownLat: number | undefined;
  subscriberSocket.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    if (parsed.type === "location") {
      receivedCount++;
      lastKnownLat = parsed.lat as number;
    } else if (parsed.type === "delta" && lastKnownLat !== undefined) {
      receivedCount++;
      lastKnownLat = lastKnownLat + (parsed.dLat as number) * QUANTIZATION_STEP_DEGREES;
    }
  });

  console.log(
    `Sending one location update every ${SEND_INTERVAL_MS}ms for ${TEST_DURATION_MS}ms ` +
      `(${Math.round(TEST_DURATION_MS / SEND_INTERVAL_MS)} raw sends)...`,
  );

  const start = Date.now();
  let sentCount = 0;
  while (Date.now() - start < TEST_DURATION_MS) {
    sentCount++;
    driverSocket.send(JSON.stringify({ lat: sentCount, lng: sentCount, timestamp: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
  }

  // Let the final coalesced update flush.
  await new Promise((resolve) => setTimeout(resolve, EXPECTED_THROTTLE_MS + 200));

  driverSocket.close();
  subscriberSocket.close();

  const expectedApprox = Math.ceil(TEST_DURATION_MS / EXPECTED_THROTTLE_MS) + 1;
  console.log(
    `\nRaw sends: ${sentCount}\nBroadcasts received: ${receivedCount}\n` +
      `Expected (approx, throttle=${EXPECTED_THROTTLE_MS}ms): ~${expectedApprox}\n` +
      `Decoded final lat: ${lastKnownLat} (should equal last sent lat: ${sentCount}, proving coalesce/last-value-wins)`,
  );

  const withinExpectedRange = receivedCount > 0 && receivedCount <= expectedApprox + 1;
  const clearlyThrottled = receivedCount < sentCount / 2;
  const lastValueWon = lastKnownLat !== undefined && Math.round(lastKnownLat) === sentCount;

  if (!withinExpectedRange || !clearlyThrottled || !lastValueWon) {
    console.error("\nFAIL: throttle behavior did not match expectations.");
    process.exitCode = 1;
    return;
  }

  console.log("\nPASS: server forwarded throttled updates at the configured rate.");
}

main().catch((err: unknown) => {
  console.error("Script failed:", err);
  process.exitCode = 1;
});
