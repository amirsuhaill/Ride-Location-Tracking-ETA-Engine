import { config } from "../config";

export interface WsRuntimeConfig {
  driverThrottleMs: number;
  heartbeatIntervalMs: number;
  timestampToleranceMs: number;
  batchWindowMs: number;
  bandwidthLogIntervalMs: number;
}

// Beyond this, batching would add more latency to a live location stream than is acceptable for
// real-time tracking — see docs/ws-batching-and-compression.md for the measured tradeoff numbers
// behind this ceiling.
export const MAX_BATCH_WINDOW_MS = 1_000;

function clampBatchWindowMs(ms: number): number {
  if (ms > MAX_BATCH_WINDOW_MS) {
    console.warn(
      `wsBatchWindowMs=${ms} exceeds MAX_BATCH_WINDOW_MS=${MAX_BATCH_WINDOW_MS}; clamping.`,
    );
    return MAX_BATCH_WINDOW_MS;
  }
  return ms;
}

// Seeded from process config, but independently overridable per buildServer() call — the test
// suite uses small windows so throttle/heartbeat/batch tests run in milliseconds, not real
// seconds.
let runtimeConfig: WsRuntimeConfig = {
  driverThrottleMs: config.wsDriverThrottleMs,
  heartbeatIntervalMs: config.wsHeartbeatIntervalMs,
  timestampToleranceMs: config.wsTimestampToleranceMs,
  batchWindowMs: clampBatchWindowMs(config.wsBatchWindowMs),
  bandwidthLogIntervalMs: config.wsBandwidthLogIntervalMs,
};

export function configureWs(overrides: Partial<WsRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...overrides };
  if (overrides.batchWindowMs !== undefined) {
    runtimeConfig.batchWindowMs = clampBatchWindowMs(overrides.batchWindowMs);
  }
}

export function getWsConfig(): WsRuntimeConfig {
  return runtimeConfig;
}
