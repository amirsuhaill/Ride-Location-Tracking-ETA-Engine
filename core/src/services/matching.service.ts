import * as tripsRepo from "../repositories/trips.repository";
import type { Trip } from "../repositories/trips.repository";
import * as driversGeoRepo from "../repositories/drivers.geo.repository";
import * as driverLockRepo from "../repositories/driver-lock.repository";
import { sendToDriver } from "../ws/driver-connections";
import { waitForDriverResponse } from "../ws/trip-offers";
import { notifyTripMatched, notifyTripStatusChanged } from "../ws/subscriptions";
import { getMatchingConfig } from "./matching-config";
import { scoreCandidate } from "./matching-score";
import { getDriverRatingScore } from "./driver-rating.service";
import { matchingLatencySeconds } from "../metrics/registry";

export type MatchOutcome =
  "matched" | "no_drivers_available" | "all_candidates_declined" | "already_resolved";

export interface MatchResult {
  outcome: MatchOutcome;
  trip: Trip;
}

/**
 * The full matching flow for one trip: search nearby online drivers, score them, and offer the
 * trip to each in ranked order until one accepts (or every candidate is exhausted). Called
 * fire-and-forget from `POST /trips` (see routes/trips.ts) — the HTTP response doesn't wait for
 * this, since a driver's accept/decline round trip can legitimately take seconds. Also directly
 * callable/awaitable, which is how the test suite drives it deterministically.
 *
 * Two distinct terminal "couldn't match" outcomes, per docs/matching.md: `no_drivers_available`
 * (the search itself returned nothing) vs. `all_candidates_declined` (candidates existed but
 * none accepted within their offer window). Both persist as `trips.status = 'cancelled'` with a
 * distinguishing `cancellation_reason` — seeing docs/matching.md for why this reuses the
 * existing terminal state instead of adding new trip_status enum values.
 */
export async function matchTrip(tripId: string): Promise<MatchResult> {
  const trip = await tripsRepo.findTripById(tripId);
  if (!trip) throw new Error(`matchTrip: trip ${tripId} not found`);

  if (trip.status !== "requested") {
    // Not this function's job to re-match an already-resolved trip (e.g. matchTrip invoked more
    // than once for the same trip, or the rider cancelled in the meantime) — report as-is. Not a
    // real matching attempt, so it's excluded from the matching-latency metric below.
    return { outcome: "already_resolved", trip };
  }

  // Phase 11's "trip-matching latency" figure (docs/load-testing.md), now a live histogram
  // instead of only the load generator's own client-side timing — observed in `finally` so every
  // terminal outcome below (matched, no_drivers_available, all_candidates_declined) is measured.
  const startedAtMs = Date.now();
  try {
    const matchConfig = getMatchingConfig();
    const candidates = await driversGeoRepo.searchNearby(
      trip.pickup.lat,
      trip.pickup.lng,
      matchConfig.searchRadiusMeters,
      matchConfig.maxCandidates,
    );

    if (candidates.length === 0) {
      return resolveUnmatched(tripId, "no_drivers_available", trip);
    }

    const now = Date.now();
    const scored = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        score: scoreCandidate(
          {
            distanceMeters: candidate.distanceMeters,
            idleTimeMs: candidate.onlineSinceMs ? now - candidate.onlineSinceMs : 0,
            ratingScore: await getDriverRatingScore(candidate.driverId),
          },
          matchConfig,
        ),
      })),
    );
    scored.sort((a, b) => b.score - a.score);

    for (const { candidate } of scored) {
      const matched = await tryOfferToDriver(trip, candidate.driverId, matchConfig.offerTimeoutMs);
      if (matched) {
        const finalTrip = await tripsRepo.findTripById(tripId);
        return { outcome: "matched", trip: finalTrip ?? trip };
      }
    }

    return resolveUnmatched(tripId, "all_candidates_declined", trip);
  } finally {
    matchingLatencySeconds.observe((Date.now() - startedAtMs) / 1000);
  }
}

async function resolveUnmatched(
  tripId: string,
  reason: "no_drivers_available" | "all_candidates_declined",
  fallback: Trip,
): Promise<MatchResult> {
  const updated = await tripsRepo.markTripUnmatched(tripId, reason);
  if (updated) {
    // Tells any rider/dispatcher subscribed to this trip that it just ended — the mechanism
    // itself (ws/subscriptions.ts#notifyTripStatusChanged) has existed and been directly tested
    // since Phase 6/websockets, but had no production caller for the cancellation path until now
    // (a real gap: a rider whose subscribe message arrived before this resolution — the normal
    // case for a cancellation that takes any real time, e.g. a full offer-timeout cycle — would
    // otherwise never learn the trip ended at all; only a subscribe racing an *already*-resolved
    // trip got the "already ended" error path instead. Found via Frontend Phase 5's own live
    // verification of a driver letting a real offer time out, see docs/frontend-driver-offers.md).
    notifyTripStatusChanged(tripId, "cancelled");
    return { outcome: reason, trip: updated };
  }
  // The guard on markTripUnmatched (WHERE status = 'requested') didn't apply — something else
  // already resolved this trip. Report its actual current state instead of a stale/misleading
  // one built from `fallback`. Deliberately no notifyTripStatusChanged here — we didn't cause
  // whatever the real resolution was, so it's not ours to announce.
  const current = (await tripsRepo.findTripById(tripId)) ?? fallback;
  return { outcome: current.status === "matched" ? "matched" : reason, trip: current };
}

/**
 * Attempts to match one specific candidate driver to a trip: acquire the distributed lock
 * (the primary double-booking defense — see docs/matching.md), offer, wait for a response, and
 * finalize atomically if accepted. Returns false for every non-match reason (locked by another
 * attempt, unreachable, declined, timed out) so the caller just moves to the next candidate.
 */
async function tryOfferToDriver(
  trip: Trip,
  driverId: string,
  offerTimeoutMs: number,
): Promise<boolean> {
  // The lock must outlive the offer wait plus the finalize step, so it can never expire out from
  // under a still-in-flight offer.
  const lockTtlMs = offerTimeoutMs + 5_000;
  const locked = await driverLockRepo.acquireDriverLock(driverId, trip.id, lockTtlMs);
  if (!locked) return false; // another matching attempt already claimed this driver

  try {
    const delivered = sendToDriver(driverId, {
      type: "trip_offer",
      tripId: trip.id,
      pickup: trip.pickup,
      dropoff: trip.dropoff,
      offerTimeoutMs,
    });
    if (!delivered) return false; // no active connection — nothing to wait for

    const accepted = await waitForDriverResponse(trip.id, offerTimeoutMs);
    if (!accepted) return false; // explicit decline or timeout

    const finalized = await tripsRepo.tryFinalizeMatch(trip.id, driverId);
    if (!finalized) return false; // guarded by the lock above already, but never trust one layer

    // tryFinalizeMatch only writes the new 'busy' status to Postgres (the transactional source of
    // truth for the match itself) — it has no reason to know about Redis's separate live geo
    // index, so without this the driver stays falsely visible to searchNearby (and therefore
    // offerable for a completely different trip) until their next routine location ping happens
    // to refresh it. Found via Frontend Phase 5's own live two-tab double-booking verification:
    // right after a real match, a direct /drivers/nearby check still returned the now-busy
    // driver. The Redis distributed lock (acquired above) is still what actually prevents a
    // *concurrent* double-booking — this closes a separate, narrower gap: a driver receiving a
    // stray trip_offer for a new trip while already mid-trip on this one, purely because the
    // cached view hadn't caught up yet. See docs/matching.md and docs/frontend-driver-offers.md.
    await driversGeoRepo.updateDriverStatusInRedis(driverId, "busy");

    sendToDriver(driverId, {
      type: "trip_matched",
      tripId: trip.id,
      pickup: trip.pickup,
      dropoff: trip.dropoff,
    });
    notifyTripMatched(trip.id, driverId);
    return true;
  } finally {
    await driverLockRepo.releaseDriverLock(driverId, trip.id);
  }
}
