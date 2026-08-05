import WebSocket from "ws";

export interface FakeDriverClient {
  driverId: string;
  sendLocation(lat: number, lng: number): void;
  close(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilDiscoverable(
  coreHttpUrl: string,
  driverId: string,
  location: { lat: number; lng: number },
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${coreHttpUrl}/drivers/nearby?lat=${location.lat}&lng=${location.lng}&radius=1000&limit=10`,
    );
    if (res.ok) {
      const body = (await res.json()) as { drivers: Array<{ driverId: string }> };
      if (body.drivers.some((d) => d.driverId === driverId)) return;
    }
    await sleep(200);
  }
  throw new Error(`driver ${driverId} never became discoverable via GET /drivers/nearby`);
}

/**
 * A real scripted driver, for the one true end-to-end test (Frontend Phase 9) — the exact same
 * WS connection pattern core/scripts/load-test-driver-fleet.ts uses against a real running core
 * (a real `ws` client, real `POST /drivers`, a real `/ws/driver?driverId=` socket), never a
 * mocked network layer. Auto-accepts the first `trip_offer` it receives (this test only ever
 * creates one trip), and exposes `sendLocation` so the test can send further real location
 * broadcasts on demand, on the same live connection, to prove the rider's driver marker actually
 * updates from a real message rather than a one-time initial render.
 */
export async function createFakeDriver(
  coreHttpUrl: string,
  coreWsUrl: string,
  location: { lat: number; lng: number },
): Promise<FakeDriverClient> {
  const createRes = await fetch(`${coreHttpUrl}/drivers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "E2E Fake Driver",
      vehicleMake: "Test",
      vehicleModel: "Fleet",
      vehicleColor: "white",
      vehiclePlate: `E2E${Date.now()}`,
      status: "online",
    }),
  });
  if (!createRes.ok) {
    throw new Error(`failed to create fake driver: ${createRes.status} ${await createRes.text()}`);
  }
  const driver = (await createRes.json()) as { id: string };

  const socket = new WebSocket(`${coreWsUrl}/ws/driver?driverId=${driver.id}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  function sendLocation(lat: number, lng: number): void {
    socket.send(JSON.stringify({ lat, lng, timestamp: Date.now() }));
  }

  // A driver isn't discoverable via GET /drivers/nearby (which reads the live Redis geo index,
  // never Postgres) until a real location update has actually been sent at least once — creating
  // the driver with `status: "online"` alone only writes the durable Postgres row. Location
  // updates are also batched server-side (WS_BATCH_WINDOW_MS, docs/ws-batching-and-compression.md)
  // before being flushed to Redis, so `sendLocation` returning doesn't mean the driver is
  // discoverable *yet* — waiting for a real GET /drivers/nearby to actually confirm it (rather
  // than a fixed sleep) is what makes the test's subsequent "Request ride" click race-free.
  sendLocation(location.lat, location.lng);
  await waitUntilDiscoverable(coreHttpUrl, driver.id, location);

  // The exact `{type, tripId, accept}` shape core/src/ws/driver-connections.ts expects
  // (docs/matching.md) — auto-accepts the one offer this test's single trip will produce.
  socket.on("message", (raw: WebSocket.RawData) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (parsed.type === "trip_offer") {
      socket.send(JSON.stringify({ type: "trip_response", tripId: parsed.tripId, accept: true }));
    }
  });

  return {
    driverId: driver.id,
    sendLocation,
    close: () => socket.terminate(),
  };
}
