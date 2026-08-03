import type { MatchingRuntimeConfig } from "./matching-config";

export interface ScoringInput {
  distanceMeters: number;
  idleTimeMs: number;
  /** Normalized 0-1, higher is better. See driver-rating.service.ts for how this is sourced. */
  ratingScore: number;
}

// Combines three normalized (0-1) signals into one score via configurable weights — see
// docs/matching.md for the default weights and the rationale behind them. This is a tunable
// heuristic, not a claim of optimality: the normalization choices (linear falloff, hard caps)
// are reasonable defaults, not derived from any real marketplace data.
export function scoreCandidate(input: ScoringInput, weights: MatchingRuntimeConfig): number {
  // Closer is better; distances at or beyond the search radius itself would already have been
  // excluded from candidates, so this never goes negative in practice.
  const distanceScore = 1 - Math.min(input.distanceMeters / weights.searchRadiusMeters, 1);

  // Longer-idle drivers get a priority boost (fairness/utilization — see docs/matching.md),
  // capped at maxIdleTimeMs so an extremely stale idle time doesn't dominate every other signal.
  const idleScore = Math.min(Math.max(input.idleTimeMs, 0) / weights.maxIdleTimeMs, 1);

  const ratingScore = Math.min(Math.max(input.ratingScore, 0), 1);

  return (
    weights.distanceWeight * distanceScore +
    weights.idleTimeWeight * idleScore +
    weights.ratingWeight * ratingScore
  );
}
