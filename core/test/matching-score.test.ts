import { describe, expect, it } from "vitest";
import { scoreCandidate } from "../src/services/matching-score";
import type { MatchingRuntimeConfig } from "../src/services/matching-config";

const weights: MatchingRuntimeConfig = {
  searchRadiusMeters: 5_000,
  maxCandidates: 5,
  offerTimeoutMs: 10_000,
  distanceWeight: 0.6,
  idleTimeWeight: 0.25,
  ratingWeight: 0.15,
  maxIdleTimeMs: 10 * 60_000,
};

describe("matching-score: scoreCandidate", () => {
  it("scores a closer driver higher than a farther one, all else equal", () => {
    const near = scoreCandidate({ distanceMeters: 100, idleTimeMs: 0, ratingScore: 0.5 }, weights);
    const far = scoreCandidate({ distanceMeters: 4_000, idleTimeMs: 0, ratingScore: 0.5 }, weights);
    expect(near).toBeGreaterThan(far);
  });

  it("scores a longer-idle driver higher than a freshly-online one, all else equal", () => {
    const idle = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: 5 * 60_000, ratingScore: 0.5 },
      weights,
    );
    const fresh = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: 0, ratingScore: 0.5 },
      weights,
    );
    expect(idle).toBeGreaterThan(fresh);
  });

  it("scores a higher-rated driver higher, all else equal", () => {
    const highRated = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: 0, ratingScore: 0.9 },
      weights,
    );
    const lowRated = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: 0, ratingScore: 0.1 },
      weights,
    );
    expect(highRated).toBeGreaterThan(lowRated);
  });

  it("caps idle-time scoring benefit at maxIdleTimeMs — beyond it, score doesn't keep climbing", () => {
    const atCap = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: weights.maxIdleTimeMs, ratingScore: 0.5 },
      weights,
    );
    const wayBeyondCap = scoreCandidate(
      { distanceMeters: 1_000, idleTimeMs: weights.maxIdleTimeMs * 10, ratingScore: 0.5 },
      weights,
    );
    expect(wayBeyondCap).toBe(atCap);
  });

  it("weights are configurable — a zero distance weight makes distance irrelevant", () => {
    const zeroDistanceWeight: MatchingRuntimeConfig = { ...weights, distanceWeight: 0 };
    const near = scoreCandidate(
      { distanceMeters: 100, idleTimeMs: 0, ratingScore: 0.5 },
      zeroDistanceWeight,
    );
    const far = scoreCandidate(
      { distanceMeters: 4_000, idleTimeMs: 0, ratingScore: 0.5 },
      zeroDistanceWeight,
    );
    expect(near).toBe(far);
  });

  it("never goes negative or produces NaN at the extremes", () => {
    const score = scoreCandidate(
      { distanceMeters: 1_000_000, idleTimeMs: -1000, ratingScore: -5 },
      weights,
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(score)).toBe(false);
  });
});
