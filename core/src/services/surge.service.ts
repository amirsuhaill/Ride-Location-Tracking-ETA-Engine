import * as driversRepo from "../repositories/drivers.repository";
import * as tripsRepo from "../repositories/trips.repository";
import * as surgeRepo from "../repositories/surge.repository";
import type { SurgeZoneState } from "../repositories/surge.repository";
import { cellOf, cellHash, decode } from "../geo/geohash";
import { getSurgeConfig } from "./surge-config";
import { logger } from "../logger";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function zoneHashFor(lat: number, lng: number, bits: number): string {
  // Redis hash fields and JSON keys are strings — the geohash itself is a bigint (Phase 12),
  // so it's stringified once here rather than at every call site.
  return cellHash(cellOf({ lat, lng }, bits), bits).toString();
}

/**
 * Recomputes every zone's surge multiplier from current open-trip-request and online-driver
 * counts, with smoothing and a minimum-sample floor. Called on a fixed interval by
 * startSurgeUpdateLoop below — deliberately never invoked per-request (see
 * docs/surge-pricing.md's "why an interval, not per-request" section). `nowMs` is a parameter
 * (not `Date.now()` inline) so tests can drive it deterministically, same convention as
 * eta.service.ts.
 */
export async function computeAndUpdateSurge(nowMs: number = Date.now()): Promise<void> {
  const cfg = getSurgeConfig();

  const [pickups, drivers] = await Promise.all([
    tripsRepo.findOpenTripPickups(),
    driversRepo.findOnlineDriversWithLocation(),
  ]);

  const requestCounts = new Map<string, number>();
  for (const p of pickups) {
    const hash = zoneHashFor(p.lat, p.lng, cfg.zoneBits);
    requestCounts.set(hash, (requestCounts.get(hash) ?? 0) + 1);
  }

  const driverCounts = new Map<string, number>();
  for (const d of drivers) {
    const hash = zoneHashFor(d.lat, d.lng, cfg.zoneBits);
    driverCounts.set(hash, (driverCounts.get(hash) ?? 0) + 1);
  }

  const previousStates = await surgeRepo.getAllSurgeZoneStates();

  // The union of "has current signal" and "had a stored multiplier before" — the latter is what
  // lets a zone whose demand has since vanished decay back toward baseline over subsequent
  // intervals, instead of being stuck at its last computed value forever.
  const allZoneHashes = new Set<string>([
    ...requestCounts.keys(),
    ...driverCounts.keys(),
    ...previousStates.keys(),
  ]);
  if (allZoneHashes.size === 0) return;

  const newStates = new Map<string, SurgeZoneState>();
  for (const zoneHash of allZoneHashes) {
    const requestCount = requestCounts.get(zoneHash) ?? 0;
    const driverCount = driverCounts.get(zoneHash) ?? 0;
    const previous = previousStates.get(zoneHash);
    const previousMultiplier = previous?.multiplier ?? cfg.minMultiplier;

    // Below the minimum sample size, there isn't enough signal to trust — target baseline rather
    // than let a single stray request (or a request with zero drivers around) swing the
    // multiplier toward the ceiling on essentially no data (docs/surge-pricing.md).
    const rawRatio = requestCount / Math.max(driverCount, 1);
    const targetMultiplier =
      requestCount < cfg.minSampleRequests
        ? cfg.minMultiplier
        : clamp(rawRatio, cfg.minMultiplier, cfg.maxMultiplier);

    // Smoothing: move at most maxChangePerInterval toward the target this tick, never jump
    // straight to it — this is what keeps one noisy interval from thrashing the multiplier.
    const delta = clamp(
      targetMultiplier - previousMultiplier,
      -cfg.maxChangePerInterval,
      cfg.maxChangePerInterval,
    );
    const multiplier = clamp(previousMultiplier + delta, cfg.minMultiplier, cfg.maxMultiplier);

    newStates.set(zoneHash, { multiplier, requestCount, driverCount, updatedAtMs: nowMs });
  }

  await surgeRepo.setSurgeZoneStates(newStates);
}

/** Pure lookup of whatever the last computeAndUpdateSurge() run stored for this location's zone
 * — never triggers a recompute itself. Returns the configured baseline if this zone has no
 * stored state yet (e.g. nothing has ever been requested there). */
export async function getSurgeMultiplierForLocation(lat: number, lng: number): Promise<number> {
  const cfg = getSurgeConfig();
  const zoneHash = zoneHashFor(lat, lng, cfg.zoneBits);
  const state = await surgeRepo.getSurgeZoneState(zoneHash);
  return state?.multiplier ?? cfg.minMultiplier;
}

export interface SurgeZoneInfo {
  zoneId: string;
  center: { lat: number; lng: number };
  multiplier: number;
  requestCount: number;
  driverCount: number;
  updatedAt: string;
}

/** Every zone with a stored multiplier, for GET /surge. */
export async function getAllSurgeZones(): Promise<SurgeZoneInfo[]> {
  const cfg = getSurgeConfig();
  const states = await surgeRepo.getAllSurgeZoneStates();
  const zones: SurgeZoneInfo[] = [];
  for (const [zoneHash, state] of states) {
    const decoded = decode(BigInt(zoneHash), cfg.zoneBits);
    zones.push({
      zoneId: zoneHash,
      center: { lat: decoded.lat, lng: decoded.lng },
      multiplier: state.multiplier,
      requestCount: state.requestCount,
      driverCount: state.driverCount,
      updatedAt: new Date(state.updatedAtMs).toISOString(),
    });
  }
  return zones;
}

let surgeTimer: NodeJS.Timeout | undefined;

export function startSurgeUpdateLoop(intervalMs: number): void {
  if (surgeTimer) return;
  surgeTimer = setInterval(() => {
    computeAndUpdateSurge().catch((err: unknown) => {
      logger.error({ err }, "computeAndUpdateSurge failed");
    });
  }, intervalMs);
  surgeTimer.unref();
}

export function stopSurgeUpdateLoop(): void {
  if (surgeTimer) {
    clearInterval(surgeTimer);
    surgeTimer = undefined;
  }
}
