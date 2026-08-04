import { config, type EtaMode } from "../config";

export interface EtaRuntimeConfig {
  avgSpeedMetersPerSecond: number;
  recomputeIntervalMs: number;
  recomputeDistanceMeters: number;
  staleLocationMs: number;
  /** heuristic | ml | ml_with_fallback — see config.ts's EtaMode doc comment. */
  mode: EtaMode;
  /** Base URL of ml-service, e.g. http://ml-service:8000 — overridden per-test to point at a
   * stub HTTP server (see test/helpers/ml-stub-server.ts). */
  mlServiceUrl: string;
  /** Max time to wait for ml-service before treating it as a failure (Phase 10). */
  mlTimeoutMs: number;
  /** Recompute-throttle time threshold used specifically when the engine in play is ML (see
   * eta.service.ts#maybeRecomputeEta) — deliberately separate from recomputeIntervalMs, which
   * still governs the heuristic path. */
  mlCacheTtlMs: number;
  /** Base URL of the OSRM routing service (Phase 15) — overridden per-test to point at a stub
   * HTTP server (see test/helpers/osrm-stub-server.ts). */
  osrmUrl: string;
  /** Whether the heuristic path tries a real OSRM route before falling back to haversine. */
  osrmEnabled: boolean;
  /** Max time to wait for OSRM before treating it as a failure (Phase 15). */
  osrmTimeoutMs: number;
}

// Seeded from process config, independently overridable per buildServer() call — tests use tiny
// recompute thresholds so throttle behavior is exercised in milliseconds/meters, not real time.
let runtimeConfig: EtaRuntimeConfig = {
  avgSpeedMetersPerSecond: config.etaAvgSpeedMetersPerSecond,
  recomputeIntervalMs: config.etaRecomputeIntervalMs,
  recomputeDistanceMeters: config.etaRecomputeDistanceMeters,
  staleLocationMs: config.etaStaleLocationMs,
  mode: config.etaMode,
  mlServiceUrl: config.mlServiceUrl,
  mlTimeoutMs: config.etaMlTimeoutMs,
  mlCacheTtlMs: config.etaMlCacheTtlMs,
  osrmUrl: config.osrmUrl,
  osrmEnabled: config.etaOsrmEnabled,
  osrmTimeoutMs: config.etaOsrmTimeoutMs,
};

export function configureEta(overrides: Partial<EtaRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...overrides };
}

export function getEtaConfig(): EtaRuntimeConfig {
  return runtimeConfig;
}
