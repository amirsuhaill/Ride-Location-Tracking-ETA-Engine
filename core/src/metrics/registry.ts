import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

/**
 * Phase 16: exposes the same real numbers this project already generates and measures (Phase 5's
 * bandwidth savings, Phase 11's location-update throughput and latency percentiles) as live,
 * scrapeable Prometheus metrics — not just numbers frozen in docs/load-testing.md and
 * docs/ws-batching-and-compression.md. `GET /internal/metrics/prometheus` (src/routes/metrics.ts)
 * renders this registry; the counters/histograms below are incremented/observed at the exact
 * event sites Phase 11's load test already measured client-side (ws/location-batch.ts's
 * enqueue/flush, matching.service.ts's matchTrip) — this module only defines the metric objects,
 * so importing it never creates a dependency cycle with the modules that record into them.
 */
export const registry = new Registry();

// Standard Node process metrics (CPU, memory, GC, event loop lag, active handles) — a normal,
// low-cost baseline for any Prometheus-scraped Node service, complementary to (not a replacement
// for) this project's own event-loop-lag/pg-pool/ws-fleet gauges set at scrape time below.
collectDefaultMetrics({ register: registry });

export const locationUpdatesTotal = new Counter({
  name: "location_updates_processed_total",
  help: "Total driver location updates processed (post-throttle, pre-batch-flush) — the numerator behind Phase 11's 'updates/sec' figure.",
  registers: [registry],
});

// Buckets span this project's own real measured range (docs/load-testing.md: p50 236-480ms,
// p99 up to 986ms at 5,000 drivers) rather than prom-client's generic HTTP-latency defaults.
export const broadcastLatencySeconds = new Histogram({
  name: "location_broadcast_latency_seconds",
  help: "Time from a driver's location update timestamp to its fleet broadcast (Phase 5 batching + Phase 11 load test).",
  buckets: [0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.75, 1, 1.5, 2],
  registers: [registry],
});

export const matchingLatencySeconds = new Histogram({
  name: "trip_matching_latency_seconds",
  help: "Time from matchTrip() starting real work to its terminal outcome (matched/no_drivers_available/all_candidates_declined) — Phase 11's trip-matching latency figure.",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5],
  registers: [registry],
});
