import { config } from "../config";

export interface MatchingRuntimeConfig {
  searchRadiusMeters: number;
  maxCandidates: number;
  offerTimeoutMs: number;
  distanceWeight: number;
  idleTimeWeight: number;
  ratingWeight: number;
  maxIdleTimeMs: number;
}

// Seeded from process config, independently overridable per buildServer() call — tests use a
// tiny offerTimeoutMs so fallback-on-timeout scenarios run in milliseconds, not real seconds.
let runtimeConfig: MatchingRuntimeConfig = {
  searchRadiusMeters: config.matchSearchRadiusMeters,
  maxCandidates: config.matchMaxCandidates,
  offerTimeoutMs: config.matchOfferTimeoutMs,
  distanceWeight: config.matchDistanceWeight,
  idleTimeWeight: config.matchIdleTimeWeight,
  ratingWeight: config.matchRatingWeight,
  maxIdleTimeMs: config.matchMaxIdleTimeMs,
};

export function configureMatching(overrides: Partial<MatchingRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...overrides };
}

export function getMatchingConfig(): MatchingRuntimeConfig {
  return runtimeConfig;
}
