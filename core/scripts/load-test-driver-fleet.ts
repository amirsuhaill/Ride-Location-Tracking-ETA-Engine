/**
 * Load-oriented script — NOT part of the automated test suite. Simulates a fleet of concurrent
 * driver WebSocket connections against a REAL running core service (start one with
 * `npm run dev` or `make up` first) and reports real, measured throughput and bandwidth-savings
 * numbers (see docs/ws-batching-and-compression.md for captured results from actual runs).
 *
 * Before running at the full 1000-driver scale, raise the open-file-descriptor limit:
 *   ulimit -n 4096
 *
 * Usage (all env vars optional):
 *   CORE_HTTP_URL=http://localhost:3000 CORE_WS_URL=ws://localhost:3000 \
 *   DRIVER_COUNT=1000 DURATION_MS=15000 SEND_INTERVAL_MS=1000 \
 *   npx tsx scripts/load-test-driver-fleet.ts
 */
import WebSocket from "ws";

const HTTP_URL = process.env.CORE_HTTP_URL ?? "http://localhost:3000";
const WS_URL = process.env.CORE_WS_URL ?? "ws://localhost:3000";
const DRIVER_COUNT = Number(process.env.DRIVER_COUNT ?? 1000);
const DURATION_MS = Number(process.env.DURATION_MS ?? 15_000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 1000);
const SETUP_CONCURRENCY = 50;
// Bandwidth/throughput can't be measured for all 1000 drivers without 1000 dedicated subscriber
// sockets (one subscription per socket, see docs/websockets.md) — a sample is enough for an
// honest, representative measurement without doubling the connection count.
const SAMPLE_SIZE = Math.min(50, DRIVER_COUNT);
const QUANTIZATION_STEP_DEGREES = 1e-5;

interface CreatedDriver {
  id: string;
}

async function createDriver(index: number): Promise<string> {
  const res = await fetch(`${HTTP_URL}/drivers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Load Test Driver ${index}`,
      vehicleMake: "Load",
      vehicleModel: "Test",
      vehicleColor: "n/a",
      vehiclePlate: `LOAD${index}-${Date.now()}`,
      status: "online",
    }),
  });
  if (!res.ok) {
    throw new Error(`create driver ${index} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as CreatedDriver;
  return body.id;
}

async function inBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const batchResults = await Promise.all(batch.map((item, i) => fn(item, start + i)));
    results.push(...batchResults);
  }
  return results;
}

function connectDriverSocket(driverId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_URL}/ws/driver?driverId=${driverId}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectSubscriberSocket(driverId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_URL}/ws/subscribe`);
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", driverId }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

interface LatLng {
  lat: number;
  lng: number;
}

async function main(): Promise<void> {
  console.log(`Creating ${DRIVER_COUNT} scratch drivers via ${HTTP_URL} ...`);
  const setupStart = Date.now();
  const driverIds = await inBatches(
    Array.from({ length: DRIVER_COUNT }, (_, i) => i),
    SETUP_CONCURRENCY,
    createDriver,
  );
  console.log(`Created ${driverIds.length} drivers in ${Date.now() - setupStart}ms.`);

  console.log(`Opening ${driverIds.length} driver WebSocket connections ...`);
  const driverSockets = await inBatches(driverIds, SETUP_CONCURRENCY, connectDriverSocket);
  console.log(`${driverSockets.length} driver connections established.`);

  const sampleIds = driverIds.slice(0, SAMPLE_SIZE);
  console.log(`Opening ${sampleIds.length} sampling subscriber connections ...`);

  const actualBytesSamples: number[] = [];
  const fullEquivalentBytesSamples: number[] = [];
  const latencySamplesMs: number[] = [];
  let sampleMessageCount = 0;

  const subscriberSockets = await inBatches(sampleIds, SETUP_CONCURRENCY, async (driverId) => {
    const socket = await connectSubscriberSocket(driverId);
    let lastKnown: (LatLng & { status: unknown }) | null = null;

    socket.on("message", (data: WebSocket.RawData) => {
      const raw = data.toString();
      const actualBytes = Buffer.byteLength(raw, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type !== "location" && parsed.type !== "delta") return;

      let current: LatLng | null = null;
      let status: unknown;
      if (parsed.type === "location") {
        current = { lat: parsed.lat as number, lng: parsed.lng as number };
        status = parsed.status;
      } else if (lastKnown) {
        current = {
          lat: lastKnown.lat + (parsed.dLat as number) * QUANTIZATION_STEP_DEGREES,
          lng: lastKnown.lng + (parsed.dLng as number) * QUANTIZATION_STEP_DEGREES,
        };
        // status is omitted from a delta message when unchanged since the last one sent to this
        // subscriber (same "send only changed fields" idea applied beyond just lat/lng) — fall
        // back to the last known value rather than reading a field that isn't there.
        status = parsed.status ?? lastKnown.status;
      }
      if (!current) return; // a delta with no prior full position — shouldn't happen, skip
      lastKnown = { ...current, status };

      // Reconstruct what a full (non-delta) payload for this exact data point would have cost,
      // for a fair before/after comparison, whether or not this particular message was full.
      const fullEquivalent = JSON.stringify({
        type: "location",
        driverId: parsed.driverId,
        lat: current.lat,
        lng: current.lng,
        timestamp: parsed.timestamp,
        status,
      });

      sampleMessageCount++;
      actualBytesSamples.push(actualBytes);
      fullEquivalentBytesSamples.push(Buffer.byteLength(fullEquivalent, "utf8"));
      // Added latency = time from the driver's original send to this broadcast actually
      // reaching the subscriber — dominated locally by the batch window itself (throttle release
      // + network/processing time are sub-millisecond on localhost).
      latencySamplesMs.push(Date.now() - (parsed.timestamp as number));
    });

    return socket;
  });
  console.log(`${subscriberSockets.length} subscriber connections established and subscribed.`);

  console.log(
    `\nRunning load test: ${driverSockets.length} drivers sending every ${SEND_INTERVAL_MS}ms ` +
      `for ${DURATION_MS}ms ...`,
  );

  let totalRawSent = 0;
  const testStart = Date.now();
  const sendTimer = setInterval(() => {
    for (const socket of driverSockets) {
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(
        JSON.stringify({
          lat: 37.7 + Math.random() * 0.1,
          lng: -122.4 + Math.random() * 0.1,
          timestamp: Date.now(),
        }),
      );
      totalRawSent++;
    }
  }, SEND_INTERVAL_MS);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(sendTimer);

  // Let the last batch window(s) flush through to subscribers before measuring.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const testElapsedSec = (Date.now() - testStart) / 1000;

  for (const socket of driverSockets) socket.terminate();
  for (const socket of subscriberSockets) socket.terminate();

  const avgBytesAfter =
    actualBytesSamples.reduce((sum, n) => sum + n, 0) / actualBytesSamples.length;
  const avgBytesBefore =
    fullEquivalentBytesSamples.reduce((sum, n) => sum + n, 0) / fullEquivalentBytesSamples.length;
  const savingsPercent = ((avgBytesBefore - avgBytesAfter) / avgBytesBefore) * 100;
  const estimatedFleetProcessedPerSec =
    (sampleMessageCount / sampleIds.length / testElapsedSec) * driverSockets.length;

  const sortedLatencies = [...latencySamplesMs].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    if (sortedLatencies.length === 0) return NaN;
    const idx = Math.min(
      sortedLatencies.length - 1,
      Math.floor((p / 100) * sortedLatencies.length),
    );
    return sortedLatencies[idx] as number;
  };
  const avgLatencyMs =
    sortedLatencies.reduce((sum, n) => sum + n, 0) / (sortedLatencies.length || 1);

  console.log("\n=== Load Test Results ===");
  console.log(`Drivers simulated:                          ${driverSockets.length}`);
  console.log(`Test duration:                               ${testElapsedSec.toFixed(1)}s`);
  console.log(
    `Raw updates sent (whole fleet):              ${totalRawSent} ` +
      `(${(totalRawSent / testElapsedSec).toFixed(1)}/sec)`,
  );
  console.log(`Sampled drivers (bandwidth/throughput):      ${sampleIds.length}`);
  console.log(`Sampled broadcasts observed:                 ${sampleMessageCount}`);
  console.log(
    `Estimated fleet-wide processed throughput:   ${estimatedFleetProcessedPerSec.toFixed(1)} updates/sec`,
  );
  console.log(`Avg bytes/message BEFORE (full-equivalent):  ${avgBytesBefore.toFixed(1)}`);
  console.log(`Avg bytes/message AFTER (actual, delta):     ${avgBytesAfter.toFixed(1)}`);
  console.log(`Bandwidth savings:                           ${savingsPercent.toFixed(1)}%`);
  console.log(
    `Added latency (send -> broadcast) avg/p50/p95/p99: ${avgLatencyMs.toFixed(0)}ms / ` +
      `${percentile(50).toFixed(0)}ms / ${percentile(95).toFixed(0)}ms / ${percentile(99).toFixed(0)}ms`,
  );
}

main().catch((err: unknown) => {
  console.error("Load test failed:", err);
  process.exitCode = 1;
});
