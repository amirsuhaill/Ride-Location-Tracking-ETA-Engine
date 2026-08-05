import { useEffect, useState } from "react";
import { getTripEta } from "../api/client";
import type { TripEta } from "../api/types";

/** Mirrors ETA_RECOMPUTE_INTERVAL_MS's default (core/.env.example, core/src/config.ts) — "a
 * few seconds" per the same order of magnitude the backend itself uses to throttle heuristic ETA
 * recomputation, not an arbitrary client-side guess. */
const ETA_POLL_INTERVAL_MS = 15_000;

export interface TripEtaState {
  eta: TripEta | null;
  /** Set only for a permanent failure (e.g. the tripId itself is invalid/gone — an `api_error`)
   * — a `network_error` is transient and left unsurfaced here (the app-wide NetworkStatusBanner
   * already covers it), so this never fires for a mere connectivity blip. Distinct from
   * `TripEta.status`'s own rich states (no_driver_assigned, trip_completed, etc., docs/API.md) —
   * those are honest 200-response data, not a request failure. */
  error: string | null;
}

const INITIAL_STATE: TripEtaState = { eta: null, error: null };

/**
 * Polls GET /trips/:id/eta while `enabled` — the caller passes `enabled: !isTerminalStatus`, so
 * the effect's own cleanup (clearing the interval) runs the moment the trip reaches
 * completed/cancelled, and the effect body's early return means no new timer gets set. A
 * completed/cancelled trip has no reason to keep hitting this endpoint.
 */
export function useTripEta(tripId: string | null, enabled: boolean): TripEtaState {
  const [state, setState] = useState<TripEtaState>(INITIAL_STATE);

  useEffect(() => {
    if (!tripId || !enabled) {
      setState(INITIAL_STATE);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const id = tripId;

    async function poll(): Promise<void> {
      const result = await getTripEta(id);
      if (cancelled) return;

      if (result.ok) {
        setState({ eta: result.data, error: null });
        return;
      }
      if (result.reason === "network_error") {
        return; // transient — keep the last-known ETA, keep polling
      }
      // A permanent rejection (the trip itself doesn't exist) — stop polling a request that can
      // only ever fail the same way again, and say so rather than leaving a stale ETA badge up.
      setState({ eta: null, error: result.message });
      if (timer) clearInterval(timer);
    }

    void poll();
    timer = setInterval(poll, ETA_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [tripId, enabled]);

  return state;
}
