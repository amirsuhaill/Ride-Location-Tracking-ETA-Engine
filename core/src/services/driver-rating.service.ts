// STUB: driver rating/acceptance-rate signal for matching (see docs/matching.md). Returns a
// deterministic pseudo-random score in [0, 1) derived from the driver's id — deterministic
// (unlike Math.random()) so the same driver scores consistently across calls/tests, without a
// real ratings table existing yet.
//
// The function is async and takes only a driverId specifically so a real implementation (e.g.
// querying an aggregated rating/acceptance-rate table) can replace the body later without
// touching any caller — matching-score.ts and matching.service.ts only ever see "a number
// between 0 and 1 for this driver," never how it was computed.
export async function getDriverRatingScore(driverId: string): Promise<number> {
  let hash = 0;
  for (let i = 0; i < driverId.length; i++) {
    hash = (hash * 31 + driverId.charCodeAt(i)) >>> 0;
  }
  return Promise.resolve((hash % 1000) / 1000);
}
