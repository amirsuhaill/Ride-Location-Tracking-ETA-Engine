import { redis } from "../redis";

// Distributed lock so two concurrent trip-matching attempts can never both proceed to offer the
// same driver — this is the primary defense against double-booking (see docs/matching.md); the
// atomic guarded UPDATE in trips.repository.ts#tryFinalizeMatch is the belt-and-suspenders
// second layer at actual commit time.
const lockKey = (driverId: string): string => `driver:${driverId}:lock`;

// Compare-and-delete via a Lua script (atomic): only release the lock if it's still ours. Without
// this, a slow matching attempt whose lock already expired (TTL) could delete a lock a
// *different*, newer matching attempt has since legitimately acquired for the same driver.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Claims a driver for this trip's matching attempt. Returns false if another attempt already
 * holds the lock (e.g. a concurrent request for a different trip is also considering this
 * driver) — the caller should treat that as "unavailable" and move to the next candidate
 * without waiting. */
export async function acquireDriverLock(
  driverId: string,
  tripId: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await redis.set(lockKey(driverId), tripId, "PX", ttlMs, "NX");
  return result === "OK";
}

export async function releaseDriverLock(driverId: string, tripId: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, lockKey(driverId), tripId);
}

export async function isDriverLockedForTests(driverId: string): Promise<boolean> {
  const value = await redis.get(lockKey(driverId));
  return value !== null;
}
