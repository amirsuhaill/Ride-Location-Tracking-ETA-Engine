import { haversineDistanceMeters, type LatLng } from "./haversine";
import { config } from "../config";
import { getSurgeMultiplierForLocation } from "./surge.service";

export interface FareEstimate {
  currency: "USD";
  baseCents: number;
  distanceCents: number;
  timeCents: number;
  subtotalCents: number;
  surgeMultiplier: number;
  totalCents: number;
}

/**
 * A trip-request-time fare quote (Phase 13, docs/surge-pricing.md): base fare + distance + time,
 * surged by the pickup location's current zone multiplier. All cents fields are integers (never
 * float currency) — rounded once at the end, not accumulated through several roundings.
 *
 * `avgSpeedMetersPerSecond` is a parameter (not read from config internally) so callers pass the
 * exact same baseline speed the heuristic ETA uses (`config.etaAvgSpeedMetersPerSecond`,
 * docs/eta.md) — the estimated duration this fare is based on is the same estimate a rider would
 * see as their ETA, not a second, independently-tuned assumption.
 *
 * This is an estimate only, computed fresh and returned — not persisted. The actual fare a rider
 * is charged (a later phase's concern) would be computed from the trip's real distance/duration
 * once completed; this number is deliberately not written to the `trips` row, consistent with how
 * ETA (docs/eta.md) is also derived/point-in-time rather than a durable column.
 */
export async function estimateFare(
  pickup: LatLng,
  dropoff: LatLng,
  avgSpeedMetersPerSecond: number,
): Promise<FareEstimate> {
  const distanceMeters = haversineDistanceMeters(pickup, dropoff);
  const etaSeconds = distanceMeters / avgSpeedMetersPerSecond;

  const baseCents = config.fareBaseCents;
  const distanceCents = (distanceMeters / 1000) * config.farePerKmCents;
  const timeCents = (etaSeconds / 60) * config.farePerMinuteCents;
  const subtotalCents = baseCents + distanceCents + timeCents;

  const surgeMultiplier = await getSurgeMultiplierForLocation(pickup.lat, pickup.lng);

  return {
    currency: "USD",
    baseCents: Math.round(baseCents),
    distanceCents: Math.round(distanceCents),
    timeCents: Math.round(timeCents),
    subtotalCents: Math.round(subtotalCents),
    surgeMultiplier,
    totalCents: Math.round(subtotalCents * surgeMultiplier),
  };
}
