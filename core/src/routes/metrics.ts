import type { FastifyInstance } from "fastify";
import { Gauge } from "prom-client";
import { pool } from "../db";
import { getEventLoopLagSnapshot } from "../services/event-loop-metrics";
import { getDriverConnectionCount } from "../ws/driver-connections";
import { getTotalSubscriberCount } from "../ws/subscriptions";
import { getPendingBatchSize } from "../ws/location-batch";
import { getBandwidthStats } from "../ws/bandwidth-metrics";
import { registry } from "../metrics/registry";

const bytesToMb = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// Gauges for state this project already tracks elsewhere (event loop lag, pg pool, ws fleet
// sizes, Phase 5 bandwidth totals) — defined here, not in metrics/registry.ts, specifically to
// avoid a circular import: this file already imports the getters below for the JSON endpoint,
// while registry.ts's Counter/Histogram objects are imported BY those same modules (e.g.
// ws/location-batch.ts) to record into. Set at scrape time (the `collect` hook), so a Prometheus
// pull always reflects current state, not whatever it was at process start.
new Gauge({
  name: "event_loop_lag_ms",
  help: "Event loop lag (node:perf_hooks monitorEventLoopDelay), Phase 11's bottleneck-diagnostic metric.",
  labelNames: ["percentile"],
  registers: [registry],
  collect() {
    const snapshot = getEventLoopLagSnapshot();
    this.set({ percentile: "mean" }, snapshot.meanMs);
    this.set({ percentile: "p50" }, snapshot.p50Ms);
    this.set({ percentile: "p95" }, snapshot.p95Ms);
    this.set({ percentile: "p99" }, snapshot.p99Ms);
    this.set({ percentile: "max" }, snapshot.maxMs);
  },
});

new Gauge({
  name: "pg_pool_connections",
  help: "Postgres pool connection state — pgPool.waitingCount is the exact metric that identified Phase 11's connection-pool-exhaustion bottleneck.",
  labelNames: ["state"],
  registers: [registry],
  collect() {
    this.set({ state: "total" }, pool.totalCount);
    this.set({ state: "idle" }, pool.idleCount);
    this.set({ state: "waiting" }, pool.waitingCount);
  },
});

new Gauge({
  name: "ws_fleet_size",
  help: "Live WebSocket fleet sizes and the pending fleet-wide location batch size.",
  labelNames: ["kind"],
  registers: [registry],
  collect() {
    this.set({ kind: "driver_connections" }, getDriverConnectionCount());
    this.set({ kind: "subscriber_connections" }, getTotalSubscriberCount());
    this.set({ kind: "pending_batch_size" }, getPendingBatchSize());
  },
});

new Gauge({
  name: "ws_bandwidth_bytes",
  help: "Cumulative location-broadcast bytes, full-payload-equivalent vs actual (Phase 5 delta compression) — savings_percent is the resume-bullet figure, live rather than frozen in docs/ws-batching-and-compression.md.",
  labelNames: ["kind"],
  registers: [registry],
  collect() {
    const stats = getBandwidthStats();
    this.set({ kind: "messages_sent" }, stats.messagesSent);
    this.set({ kind: "full_payload_equivalent" }, stats.fullPayloadEquivalentBytes);
    this.set({ kind: "actual_sent" }, stats.actualBytesSent);
    this.set({ kind: "savings_percent" }, stats.savingsPercent);
  },
});

/**
 * Diagnostics for load testing (Phase 11, docs/load-testing.md) — event loop lag, the Postgres
 * pool's own live queueing stats, memory, and WS/batch fleet sizes, all in one place so a load
 * generator can poll a single endpoint rather than needing separate instrumentation per
 * subsystem. `pgPool.waitingCount` in particular is the direct, hard evidence (not a guess) for
 * the connection-pool-exhaustion bottleneck documented there: it's the exact number of queries
 * currently blocked waiting for a free client.
 *
 * Unauthenticated and unversioned by design — this is a dev/ops diagnostic endpoint for a
 * single-tenant project at this stage, not a public API. Would need auth before ever being
 * exposed outside a trusted network.
 */
export async function metricsRoute(app: FastifyInstance): Promise<void> {
  app.get("/internal/metrics", async () => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      uptimeSec: process.uptime(),
      eventLoopLag: getEventLoopLagSnapshot(),
      memory: {
        rssMb: bytesToMb(mem.rss),
        heapUsedMb: bytesToMb(mem.heapUsed),
        heapTotalMb: bytesToMb(mem.heapTotal),
        externalMb: bytesToMb(mem.external),
      },
      // Raw cumulative counters, not a percentage — process.cpuUsage() only reports CPU time
      // *since process start*, so a meaningful percentage requires the caller to sample this
      // twice and divide the delta by its own polling interval (exactly what
      // scripts/load-test-system.ts does).
      cpu: { userMicros: cpu.user, systemMicros: cpu.system },
      pgPool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
      ws: {
        driverConnections: getDriverConnectionCount(),
        subscriberConnections: getTotalSubscriberCount(),
        pendingBatchSize: getPendingBatchSize(),
      },
    };
  });

  // Phase 16: the same real numbers above (plus the Counter/Histogram metrics recorded directly
  // at their event sites — src/metrics/registry.ts) in Prometheus text exposition format, so
  // Phase 5's bandwidth savings and Phase 11's throughput/latency figures are live-queryable
  // rather than frozen in docs/*.md. Gauges above are registered with a `collect()` hook, so
  // `registry.metrics()` always renders their current value at scrape time.
  app.get("/internal/metrics/prometheus", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
