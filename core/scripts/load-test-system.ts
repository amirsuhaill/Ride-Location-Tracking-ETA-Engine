/**
 * Phase 11 load generator — NOT part of the automated test suite. Simulates a fleet of concurrent
 * driver WebSocket connections sending location updates AND a concurrent stream of real trip
 * requests being matched against that same fleet, against a REAL running core service (start one
 * first — see docs/load-testing.md for exactly how this was run). Reports real, measured
 * throughput, location-broadcast latency, and trip-matching latency percentiles, plus samples
 * from GET /internal/metrics (event loop lag, Postgres pool queueing, memory) and Redis INFO
 * throughout the run — see docs/load-testing.md for captured results and the identified
 * bottleneck.
 *
 * Deliberately does NOT load-test location streaming in isolation from matching: real trip
 * requests run the whole time, competing for the same Postgres pool, Redis, and event loop as the
 * location fleet — that contention is exactly what this phase is measuring.
 *
 * Usage (env vars, all optional):
 *   DRIVER_COUNT=2000 SUBSCRIBER_FRACTION=0.25 SEND_INTERVAL_MS=2000 \
 *   TRIP_REQUEST_INTERVAL_MS=500 DURATION_MS=30000 \
 *   npx tsx scripts/load-test-system.ts
 */
import WebSocket from "ws";
import Redis from "ioredis";
import {
  inBatches,
  randomInBbox,
  jitterPosition,
  createDriver,
  createRider,
  connectDriverSocket,
  connectSubscriberSocket,
  LatencyStats,
  formatLatency,
} from "./lib/ws-load-helpers";

const HTTP_URL = process.env.CORE_HTTP_URL ?? "http://localhost:3000";
const WS_URL = process.env.CORE_WS_URL ?? "ws://localhost:3000";
const REDIS_URL = process.env.LOAD_TEST_REDIS_URL ?? "redis://localhost:6379";

const DRIVER_COUNT = Number(process.env.DRIVER_COUNT ?? 2000);
const SUBSCRIBER_FRACTION = Number(process.env.SUBSCRIBER_FRACTION ?? 0.25);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 2000);
const TRIP_REQUEST_INTERVAL_MS = Number(process.env.TRIP_REQUEST_INTERVAL_MS ?? 500);
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
const METRICS_POLL_INTERVAL_MS = Number(process.env.METRICS_POLL_INTERVAL_MS ?? 1000);
const RIDER_POOL_SIZE = Number(process.env.RIDER_POOL_SIZE ?? 100);
const TRIP_MATCH_WAIT_TIMEOUT_MS = Number(process.env.TRIP_MATCH_WAIT_TIMEOUT_MS ?? 20_000);
const SETUP_CONCURRENCY = Number(process.env.SETUP_CONCURRENCY ?? 100);

interface MetricsSnapshot {
  uptimeSec: number;
  eventLoopLag: { meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  cpu: { userMicros: number; systemMicros: number };
  pgPool: { totalCount: number; idleCount: number; waitingCount: number };
  ws: { driverConnections: number; subscriberConnections: number; pendingBatchSize: number };
}

async function fetchMetrics(): Promise<MetricsSnapshot | null> {
  try {
    const res = await fetch(`${HTTP_URL}/internal/metrics`);
    if (!res.ok) return null;
    return (await res.json()) as MetricsSnapshot;
  } catch {
    return null;
  }
}

interface DriverState {
  id: string;
  socket: WebSocket;
  lat: number;
  lng: number;
}

async function main(): Promise<void> {
  console.log(
    `Config: drivers=${DRIVER_COUNT} subscriberFraction=${SUBSCRIBER_FRACTION} ` +
      `sendIntervalMs=${SEND_INTERVAL_MS} tripRequestIntervalMs=${TRIP_REQUEST_INTERVAL_MS} ` +
      `durationMs=${DURATION_MS}`,
  );

  console.log(`Creating ${RIDER_POOL_SIZE} riders ...`);
  const riderIds = await inBatches(
    Array.from({ length: RIDER_POOL_SIZE }, (_, i) => i),
    SETUP_CONCURRENCY,
    (i) => createRider(HTTP_URL, i),
  );

  console.log(`Creating ${DRIVER_COUNT} drivers ...`);
  const setupStart = Date.now();
  const driverIds = await inBatches(
    Array.from({ length: DRIVER_COUNT }, (_, i) => i),
    SETUP_CONCURRENCY,
    (i) => createDriver(HTTP_URL, i),
  );
  console.log(`Created ${driverIds.length} drivers in ${Date.now() - setupStart}ms.`);

  console.log(`Opening ${driverIds.length} driver WebSocket connections ...`);
  const drivers: DriverState[] = await inBatches(driverIds, SETUP_CONCURRENCY, async (id) => {
    const socket = await connectDriverSocket(WS_URL, id);
    // Simulated drivers must actually speak the accept/decline handshake (docs/matching.md) —
    // immediately accepting every offer maximizes real match throughput for this test, so trip
    // requests genuinely compete for drivers rather than every offer silently timing out
    // (MATCH_OFFER_TIMEOUT_MS, unanswered = treated as a decline).
    socket.on("message", (raw) => {
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
    const pos = randomInBbox();
    return { id, socket, lat: pos.lat, lng: pos.lng };
  });
  console.log(`${drivers.length} driver connections established.`);

  // Subscribe to a fraction of the fleet's location broadcasts — enough to genuinely stress the
  // per-update fanout path (not just a small fixed sample), while still being a real subset (one
  // subscriber connection per watched driver, matching docs/websockets.md's one-subscription-per-
  // socket design).
  const subscriberCount = Math.round(drivers.length * SUBSCRIBER_FRACTION);
  const subscribedDrivers = drivers.slice(0, subscriberCount);
  console.log(`Opening ${subscribedDrivers.length} location-subscriber connections ...`);

  const broadcastLatency = new LatencyStats();
  let broadcastMessageCount = 0;

  const subscriberSockets = await inBatches(subscribedDrivers, SETUP_CONCURRENCY, async (d) => {
    const socket = await connectSubscriberSocket(WS_URL);
    socket.send(JSON.stringify({ type: "subscribe", driverId: d.id }));
    socket.on("message", (raw) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed.type !== "location" && parsed.type !== "delta") return;
      if (typeof parsed.timestamp !== "number") return;
      broadcastMessageCount++;
      broadcastLatency.record(Date.now() - parsed.timestamp);
    });
    return socket;
  });
  console.log(`${subscriberSockets.length} location subscribers established.`);

  // Send an initial location immediately (not waiting for the first interval tick) so every
  // driver is geo-indexed and matchable right away, not just eventually.
  for (const d of drivers) {
    if (d.socket.readyState === d.socket.OPEN) {
      d.socket.send(JSON.stringify({ lat: d.lat, lng: d.lng, timestamp: Date.now() }));
    }
  }

  const metricsSamples: MetricsSnapshot[] = [];
  let lastCpu = { userMicros: 0, systemMicros: 0 };
  let lastCpuAtMs = Date.now();

  const matchLatency = new LatencyStats();
  let tripsRequested = 0;
  let tripsMatched = 0;
  let tripsUnmatched = 0;
  let tripsTimedOut = 0;

  async function runOneTripRequest(): Promise<void> {
    const riderId = riderIds[Math.floor(Math.random() * riderIds.length)]!;
    const pickup = randomInBbox();
    const dropoff = randomInBbox();
    const requestedAtMs = Date.now();
    tripsRequested++;

    let tripId: string;
    try {
      const res = await fetch(`${HTTP_URL}/trips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ riderId, pickup, dropoff }),
      });
      if (!res.ok) return;
      tripId = ((await res.json()) as { id: string }).id;
    } catch {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve();
      };

      const timer = setTimeout(() => {
        tripsTimedOut++;
        finish();
      }, TRIP_MATCH_WAIT_TIMEOUT_MS);

      const socket = new WebSocket(`${WS_URL}/ws/subscribe`);
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "subscribe", tripId }));
      });
      socket.on("message", (raw) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (parsed.type === "trip_matched") {
          tripsMatched++;
          matchLatency.record(Date.now() - requestedAtMs);
          finish();
        } else if (parsed.type === "unsubscribed" && parsed.reason === "trip_cancelled") {
          tripsUnmatched++;
          finish();
        }
      });
      socket.once("error", () => finish());
    });
  }

  console.log(`\nRunning load test for ${DURATION_MS}ms ...`);
  const testStart = Date.now();

  const sendTimer = setInterval(() => {
    for (const d of drivers) {
      if (d.socket.readyState !== d.socket.OPEN) continue;
      const moved = jitterPosition(d.lat, d.lng);
      d.lat = moved.lat;
      d.lng = moved.lng;
      d.socket.send(JSON.stringify({ lat: d.lat, lng: d.lng, timestamp: Date.now() }));
    }
  }, SEND_INTERVAL_MS);

  // Tracked (not fire-and-forget) so the script can actually wait for every in-flight trip to
  // resolve — matched, unmatched, or its own internal timeout — before measuring/exiting, rather
  // than abandoning whatever's still pending when the fixed test duration ends.
  const inFlightTripPromises: Promise<void>[] = [];
  const tripTimer = setInterval(() => {
    const promise = runOneTripRequest().catch((err: unknown) =>
      console.error("trip request failed:", err),
    );
    inFlightTripPromises.push(promise);
  }, TRIP_REQUEST_INTERVAL_MS);

  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect().catch((err: unknown) => console.error("redis connect failed:", err));
  let lastRedisInfo = "";

  const metricsTimer = setInterval(() => {
    void (async () => {
      const snapshot = await fetchMetrics();
      if (snapshot) {
        metricsSamples.push(snapshot);
        const nowMs = Date.now();
        const elapsedMs = nowMs - lastCpuAtMs;
        // process.cpuUsage() is cumulative since process start — CPU% over this poll window is
        // (CPU time consumed during the window) / (wall-clock time in the window).
        const deltaCpuMs =
          (snapshot.cpu.userMicros -
            lastCpu.userMicros +
            snapshot.cpu.systemMicros -
            lastCpu.systemMicros) /
          1000;
        const cpuPct = elapsedMs > 0 ? (deltaCpuMs / elapsedMs) * 100 : 0;
        lastCpu = snapshot.cpu;
        lastCpuAtMs = nowMs;
        console.log(
          `[t=${((nowMs - testStart) / 1000).toFixed(0)}s] ` +
            `eventLoopLag(p99)=${snapshot.eventLoopLag.p99Ms.toFixed(1)}ms ` +
            `pgPool(waiting)=${snapshot.pgPool.waitingCount} ` +
            `pendingBatch=${snapshot.ws.pendingBatchSize} ` +
            `rss=${snapshot.memory.rssMb}MB cpu~=${cpuPct.toFixed(0)}% ` +
            `matched=${tripsMatched} unmatched=${tripsUnmatched} timedOut=${tripsTimedOut}`,
        );
      }
      try {
        lastRedisInfo = await redis.info("stats");
      } catch {
        /* keep the last successful snapshot */
      }
    })();
  }, METRICS_POLL_INTERVAL_MS);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(sendTimer);
  clearInterval(tripTimer);

  // Wait for every in-flight trip request to actually resolve (matched, unmatched, or its own
  // TRIP_MATCH_WAIT_TIMEOUT_MS internal timeout) — not a fixed guess at how long that takes.
  console.log(
    `\nDraining ${inFlightTripPromises.length} in-flight trip request(s) ` +
      `(up to ${TRIP_MATCH_WAIT_TIMEOUT_MS}ms each) ...`,
  );
  await Promise.all(inFlightTripPromises);
  // A couple more batch-flush windows so the very last location updates broadcast/persist
  // before the final metrics snapshot.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearInterval(metricsTimer);

  const finalMetrics = await fetchMetrics();
  const testElapsedSec = (Date.now() - testStart) / 1000;

  for (const d of drivers) d.socket.terminate();
  for (const s of subscriberSockets) s.terminate();
  await redis.quit().catch(() => undefined);

  const peakEventLoopP99 = Math.max(0, ...metricsSamples.map((m) => m.eventLoopLag.p99Ms));
  const peakWaitingCount = Math.max(0, ...metricsSamples.map((m) => m.pgPool.waitingCount));
  const peakPendingBatch = Math.max(0, ...metricsSamples.map((m) => m.ws.pendingBatchSize));
  const peakRssMb = Math.max(0, ...metricsSamples.map((m) => m.memory.rssMb));

  console.log("\n=== Load Test Results ===");
  console.log(`Drivers:                          ${drivers.length}`);
  console.log(`Location subscribers:             ${subscriberSockets.length}`);
  console.log(`Test duration:                    ${testElapsedSec.toFixed(1)}s`);
  console.log(
    `Location updates sent (approx):   ${Math.round(
      (drivers.length * DURATION_MS) / SEND_INTERVAL_MS,
    )} (${((drivers.length * 1000) / SEND_INTERVAL_MS).toFixed(1)}/sec target rate)`,
  );
  console.log(`Location-broadcast messages observed: ${broadcastMessageCount}`);
  console.log(`Location-broadcast latency:       ${formatLatency(broadcastLatency.summary())}`);
  console.log(
    `Trips requested/matched/unmatched/timedOut: ${tripsRequested}/${tripsMatched}/${tripsUnmatched}/${tripsTimedOut}`,
  );
  console.log(`Trip-matching latency:           ${formatLatency(matchLatency.summary())}`);
  console.log(`Peak event loop lag (p99):       ${peakEventLoopP99.toFixed(1)}ms`);
  console.log(`Peak pg pool waitingCount:        ${peakWaitingCount}`);
  console.log(`Peak pending batch size:          ${peakPendingBatch}`);
  console.log(`Peak RSS:                         ${peakRssMb}MB`);
  if (finalMetrics) {
    console.log(`Final pgPool: ${JSON.stringify(finalMetrics.pgPool)}`);
    console.log(`Final ws: ${JSON.stringify(finalMetrics.ws)}`);
  }
  console.log(`\nLast Redis INFO stats snapshot:\n${lastRedisInfo}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Load test failed:", err);
    process.exit(1);
  });
