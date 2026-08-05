import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv();

/** Which engine(s) GET /trips/:id/eta uses — see docs/eta-integration.md.
 * - "heuristic": Phase 7's haversine + rush-hour estimate only, never calls ml-service.
 * - "ml": ml-service's /predict-eta only — no fallback, so ML failures are surfaced directly
 *   (degrading to the last cached value, same as any other "couldn't get a fresh number" case)
 *   rather than silently masked by the heuristic. Meant for demoing/evaluating the model in
 *   isolation, not for production use without a fallback.
 * - "ml_with_fallback": tries ml-service first; falls back to the heuristic on any failure
 *   (unreachable, timeout, or a malformed/error response).
 */
export type EtaMode = "heuristic" | "ml" | "ml_with_fallback";

function parseEtaMode(value: string | undefined): EtaMode {
  if (value === "heuristic" || value === "ml" || value === "ml_with_fallback") return value;
  if (value !== undefined) {
    throw new Error(
      `ETA_MODE must be one of "heuristic", "ml", "ml_with_fallback" — got: ${value}`,
    );
  }
  return "heuristic";
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`expected "true" or "false" — got: ${value}`);
}

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  mlServiceUrl: string;
  appVersion: string;
  buildVersion: string;
  /** Browser origins allowed to call this API cross-origin (see src/server.ts's @fastify/cors
   * registration) — a browser-based frontend (a different origin: a different port, in local
   * dev) is otherwise blocked by same-origin policy before its request ever reaches a route
   * handler at all, regardless of anything the handler itself does. Comma-separated; defaults to
   * Vite's own default dev server port so `npm run dev` in /frontend works against a locally
   * running core with zero config. */
  corsOrigins: string[];
  /**
   * Where the built frontend's static assets live on disk (Frontend Phase 10, see
   * docs/frontend-deploy.md) — defaults to the exact path the real production Dockerfile copies
   * them to (`/app/public`, a sibling of `dist/` where this compiled file itself runs from), so
   * the common Docker deployment needs zero extra configuration. Left unset (the directory simply
   * doesn't exist) in local dev/the test suite, where no frontend build has ever been copied
   * anywhere near core — server.ts checks existence before registering static serving at all, so
   * this never affects dev/test behavior.
   */
  frontendDistPath: string;
  /**
   * Explicit overrides for what the served `/runtime-config.js` tells the frontend to call this
   * API/WebSocket server at. Left empty (the default) means "derive from the actual incoming
   * request's own Host header" — correct with zero configuration for the common case (frontend
   * and core served from the same origin), and for a reverse proxy that forwards the real
   * Host. Setting these explicitly is what lets one built frontend bundle point at a *different*
   * core instance than the one serving its static files — the real proof this project's
   * build-time-vs-runtime env var decision (Phase 0's original gotcha) actually works, not just a
   * design discussed in a doc (docs/frontend-deploy.md).
   */
  publicCoreApiUrl: string;
  publicCoreWsUrl: string;
  /** A driver's live Redis entry older than this is treated as stale (see docs/redis-geo.md). */
  driverStaleMs: number;
  /** How often the background reconciliation job scans for stale driver entries. */
  reconcileIntervalMs: number;
  /** Max processed driver location updates per second over WebSocket (see docs/websockets.md). */
  wsDriverThrottleMs: number;
  /** Ping/pong heartbeat interval for WebSocket connections. */
  wsHeartbeatIntervalMs: number;
  /** A driver location update's client-supplied timestamp must be within this many ms of server time. */
  wsTimestampToleranceMs: number;
  /** Window over which driver location updates are batched before a single Redis+Postgres flush and broadcast (see docs/ws-batching-and-compression.md). */
  wsBatchWindowMs: number;
  /** How often the cumulative delta-compression bandwidth summary is logged. */
  wsBandwidthLogIntervalMs: number;

  /** Radius searched for candidate drivers when matching a new trip (see docs/matching.md). */
  matchSearchRadiusMeters: number;
  /** Max number of nearby candidates considered per match attempt, best-scored first. */
  matchMaxCandidates: number;
  /** How long an offered driver has to accept/decline before matching falls back to the next candidate. */
  matchOfferTimeoutMs: number;
  /** Scoring weight for distance-to-pickup (closer = higher score). */
  matchDistanceWeight: number;
  /** Scoring weight for driver idle time (longer idle = higher score, up to matchMaxIdleTimeMs). */
  matchIdleTimeWeight: number;
  /** Scoring weight for the (stubbed) driver rating/acceptance-rate signal. */
  matchRatingWeight: number;
  /** Idle time at or beyond this is treated as maximally idle for scoring purposes. */
  matchMaxIdleTimeMs: number;

  /** Baseline average driving speed used for the heuristic ETA (see docs/eta.md). */
  etaAvgSpeedMetersPerSecond: number;
  /** Minimum time between ETA recomputes for a given trip, even if the driver keeps moving. */
  etaRecomputeIntervalMs: number;
  /** Minimum driver movement (from the position the last ETA was computed at) to trigger a recompute. */
  etaRecomputeDistanceMeters: number;
  /** A driver's location older than this is too stale to compute a trustworthy ETA from. */
  etaStaleLocationMs: number;
  /** Which engine(s) GET /trips/:id/eta uses (see the EtaMode doc comment above). */
  etaMode: EtaMode;
  /** Max time to wait for ml-service's /predict-eta before treating it as a failure (Phase 10). */
  etaMlTimeoutMs: number;
  /** Minimum time between ML recomputes for a given trip — separate from (and typically much
   * shorter than) etaRecomputeIntervalMs, since a heuristic recompute is a free local
   * calculation while an ML recompute is a network call worth protecting ml-service from being
   * hammered by rapid location updates. Uses the exact same throttle mechanism as
   * etaRecomputeIntervalMs (see eta.service.ts#maybeRecomputeEta) — just a different threshold
   * value depending on which engine is in play, not a second parallel cache. */
  etaMlCacheTtlMs: number;

  /** Base URL of the OSRM routing service (Phase 15, see docs/osrm-routing.md), e.g.
   * http://osrm:5000. */
  osrmUrl: string;
  /** Whether the heuristic ETA path attempts a real road-network OSRM route before falling back
   * to straight-line haversine — off by default so a fresh checkout without a built OSRM dataset
   * degrades to the pre-Phase-15 behavior instead of failing every request. */
  etaOsrmEnabled: boolean;
  /** Max time to wait for OSRM's /route before treating it as a failure and falling back to the
   * haversine heuristic — same fallback mechanism/pattern as etaMlTimeoutMs (Phase 10). */
  etaOsrmTimeoutMs: number;

  /** Surge zones are geohash cells sized to roughly this radius (see docs/surge-pricing.md) —
   * reuses Phase 12's precisionForRadius to turn a real-world distance into a bit precision,
   * rather than a raw, hard-to-reason-about bit count. */
  surgeZoneRadiusMeters: number;
  /** How often the background job recomputes every zone's surge multiplier — deliberately not
   * per-request (see docs/surge-pricing.md). */
  surgeUpdateIntervalMs: number;
  /** Surge never goes below this (no "discount" multiplier). */
  surgeMinMultiplier: number;
  /** Surge never goes above this, regardless of how extreme a zone's demand/supply ratio is. */
  surgeMaxMultiplier: number;
  /** A zone needs at least this many open trip requests before surge is allowed to move off the
   * floor at all — the guard against "1 request, 0 drivers" spiking to the ceiling on no real
   * signal. */
  surgeMinSampleRequests: number;
  /** Max amount a zone's multiplier may move, up or down, in a single update interval — the
   * smoothing/anti-thrashing cap. */
  surgeMaxChangePerInterval: number;

  /** Flat fare component, in cents (see docs/surge-pricing.md's fare formula). */
  fareBaseCents: number;
  /** Per-kilometer fare component, in cents. */
  farePerKmCents: number;
  /** Per-minute fare component, in cents. */
  farePerMinuteCents: number;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  mlServiceUrl: process.env.ML_SERVICE_URL ?? "",
  appVersion: process.env.APP_VERSION ?? "0.1.0",
  buildVersion: process.env.BUILD_VERSION ?? "local",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  frontendDistPath: process.env.FRONTEND_DIST_PATH ?? path.join(__dirname, "../public"),
  publicCoreApiUrl: process.env.PUBLIC_CORE_API_URL ?? "",
  publicCoreWsUrl: process.env.PUBLIC_CORE_WS_URL ?? "",
  driverStaleMs: Number(process.env.DRIVER_STALE_MS ?? 90_000),
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS ?? 30_000),
  wsDriverThrottleMs: Number(process.env.WS_DRIVER_THROTTLE_MS ?? 1_000),
  wsHeartbeatIntervalMs: Number(process.env.WS_HEARTBEAT_INTERVAL_MS ?? 30_000),
  wsTimestampToleranceMs: Number(process.env.WS_TIMESTAMP_TOLERANCE_MS ?? 5 * 60_000),
  wsBatchWindowMs: Number(process.env.WS_BATCH_WINDOW_MS ?? 300),
  wsBandwidthLogIntervalMs: Number(process.env.WS_BANDWIDTH_LOG_INTERVAL_MS ?? 30_000),
  matchSearchRadiusMeters: Number(process.env.MATCH_SEARCH_RADIUS_METERS ?? 5_000),
  matchMaxCandidates: Number(process.env.MATCH_MAX_CANDIDATES ?? 5),
  matchOfferTimeoutMs: Number(process.env.MATCH_OFFER_TIMEOUT_MS ?? 10_000),
  matchDistanceWeight: Number(process.env.MATCH_DISTANCE_WEIGHT ?? 0.6),
  matchIdleTimeWeight: Number(process.env.MATCH_IDLE_TIME_WEIGHT ?? 0.25),
  matchRatingWeight: Number(process.env.MATCH_RATING_WEIGHT ?? 0.15),
  matchMaxIdleTimeMs: Number(process.env.MATCH_MAX_IDLE_TIME_MS ?? 10 * 60_000),
  etaAvgSpeedMetersPerSecond: Number(process.env.ETA_AVG_SPEED_MPS ?? 8),
  etaRecomputeIntervalMs: Number(process.env.ETA_RECOMPUTE_INTERVAL_MS ?? 15_000),
  etaRecomputeDistanceMeters: Number(process.env.ETA_RECOMPUTE_DISTANCE_METERS ?? 200),
  etaStaleLocationMs: Number(process.env.ETA_STALE_LOCATION_MS ?? 60_000),
  etaMode: parseEtaMode(process.env.ETA_MODE),
  etaMlTimeoutMs: Number(process.env.ETA_ML_TIMEOUT_MS ?? 200),
  etaMlCacheTtlMs: Number(process.env.ETA_ML_CACHE_TTL_MS ?? 5_000),
  osrmUrl: process.env.OSRM_URL ?? "",
  etaOsrmEnabled: parseBool(process.env.ETA_OSRM_ENABLED, false),
  etaOsrmTimeoutMs: Number(process.env.ETA_OSRM_TIMEOUT_MS ?? 300),
  surgeZoneRadiusMeters: Number(process.env.SURGE_ZONE_RADIUS_METERS ?? 2_000),
  surgeUpdateIntervalMs: Number(process.env.SURGE_UPDATE_INTERVAL_MS ?? 15_000),
  surgeMinMultiplier: Number(process.env.SURGE_MIN_MULTIPLIER ?? 1.0),
  surgeMaxMultiplier: Number(process.env.SURGE_MAX_MULTIPLIER ?? 3.0),
  surgeMinSampleRequests: Number(process.env.SURGE_MIN_SAMPLE_REQUESTS ?? 3),
  surgeMaxChangePerInterval: Number(process.env.SURGE_MAX_CHANGE_PER_INTERVAL ?? 0.3),
  fareBaseCents: Number(process.env.FARE_BASE_CENTS ?? 250),
  farePerKmCents: Number(process.env.FARE_PER_KM_CENTS ?? 150),
  farePerMinuteCents: Number(process.env.FARE_PER_MINUTE_CENTS ?? 25),
};
