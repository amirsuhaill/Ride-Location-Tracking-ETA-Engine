import { useEffect, useState } from "react";
import { getSurgeAtPoint } from "../api/client";
import type { LatLng, SurgePointResponse } from "../api/types";
import { SURGE_UPDATE_INTERVAL_MS } from "../constants";

export interface SurgeAtPointState {
  surge: SurgePointResponse | null;
  /** Set only for a permanent failure (an `api_error` — core rejected the request outright, e.g.
   * a malformed coordinate) — never for a `network_error`. A `network_error` is transient by
   * nature (worth quietly retrying, and already covered by the app-wide NetworkStatusBanner);
   * an `api_error` means the exact same request would fail again forever, so it stops the poll
   * entirely rather than hammering core with a request that can only ever fail the same way
   * (Frontend Phase 8, docs/frontend-resilience.md). */
  error: string | null;
}

const INITIAL_STATE: SurgeAtPointState = { surge: null, error: null };

/**
 * Polls GET /surge?lat=&lng= for one specific point — used by the rider request flow to show
 * "what POST /trips will actually charge" for the current pickup zone *before* submitting, not a
 * stale or separately re-derived guess (docs/surge-pricing.md: every read is a plain lookup of
 * whatever the last SURGE_UPDATE_INTERVAL_MS tick computed, so this and the eventual
 * `fareEstimate.surgeMultiplier` are reading the exact same underlying value). Refetches
 * immediately when `point` changes (a new pickup is potentially a new zone) and otherwise polls
 * on the same real interval the backend recomputes on, same reasoning as useSurgeZones.ts.
 */
export function useSurgeAtPoint(point: LatLng | null, enabled: boolean): SurgeAtPointState {
  const [state, setState] = useState<SurgeAtPointState>(INITIAL_STATE);

  useEffect(() => {
    if (!point || !enabled) {
      setState(INITIAL_STATE);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const target = point;

    async function poll(): Promise<void> {
      const result = await getSurgeAtPoint(target);
      if (cancelled) return;

      if (result.ok) {
        setState({ surge: result.data, error: null });
        return;
      }
      if (result.reason === "network_error") {
        return; // transient — leave the last-known value in place, keep polling
      }
      // A real, permanent rejection (e.g. core validation of the coordinate itself) — stop
      // polling a request that would only ever fail the same way again, and say so honestly
      // instead of leaving the UI implying "still loading" forever.
      setState({ surge: null, error: result.message });
      if (timer) clearInterval(timer);
    }

    void poll();
    timer = setInterval(poll, SURGE_UPDATE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [point, enabled]);

  return state;
}
