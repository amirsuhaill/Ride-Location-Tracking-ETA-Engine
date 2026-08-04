import { redis } from "../redis";

// Surge multipliers are derived/live state (recomputed periodically from current trips/drivers),
// not durable source-of-truth data — same durable-vs-live split as docs/redis-geo.md and
// docs/eta.md, so this lives in Redis rather than as Postgres columns. One Hash, one field per
// zone (keyed by the zone's geohash cell integer, as a decimal string) — this doubles as the
// "which zones have we ever seen" set (HKEYS), which surge.service.ts needs so a zone whose
// demand later disappears still gets revisited and decayed back toward baseline, not left
// stuck at its last value forever.
const SURGE_STATE_KEY = "surge:state";

export interface SurgeZoneState {
  multiplier: number;
  requestCount: number;
  driverCount: number;
  updatedAtMs: number;
}

export async function getSurgeZoneState(zoneHash: string): Promise<SurgeZoneState | null> {
  const raw = await redis.hget(SURGE_STATE_KEY, zoneHash);
  if (!raw) return null;
  return JSON.parse(raw) as SurgeZoneState;
}

export async function getAllSurgeZoneStates(): Promise<Map<string, SurgeZoneState>> {
  const raw = await redis.hgetall(SURGE_STATE_KEY);
  const result = new Map<string, SurgeZoneState>();
  for (const [zoneHash, value] of Object.entries(raw)) {
    result.set(zoneHash, JSON.parse(value) as SurgeZoneState);
  }
  return result;
}

/** Writes every zone's freshly-computed state in one round trip. */
export async function setSurgeZoneStates(states: Map<string, SurgeZoneState>): Promise<void> {
  if (states.size === 0) return;
  const fields: Record<string, string> = {};
  for (const [zoneHash, state] of states) {
    fields[zoneHash] = JSON.stringify(state);
  }
  await redis.hset(SURGE_STATE_KEY, fields);
}
