import { config as loadEnv } from "dotenv";

loadEnv();

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
};
