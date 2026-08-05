import { useEffect, useState } from "react";
import { getSurgeZones } from "../api/client";
import type { SurgeZone } from "../api/types";
import { SURGE_UPDATE_INTERVAL_MS } from "../constants";

export interface SurgeZonesState {
  zones: SurgeZone[];
  /** True once a real response (any response — including a genuinely empty one) has landed at
   * least once. Distinguishes "confirmed zero zones currently show surge" from "hasn't fetched
   * yet" — both render as an empty `zones` array otherwise, and only one of them is an honest
   * empty state rather than a still-loading one (Frontend Phase 8, docs/frontend-resilience.md). */
  hasLoaded: boolean;
}

/**
 * Polls GET /surge on the same real interval the backend recomputes it on
 * (SURGE_UPDATE_INTERVAL_MS, docs/surge-pricing.md) — every read in between would just be the
 * exact same cached value, so polling faster buys nothing (mirrors useTripEta.ts's identical
 * reasoning for ETA_RECOMPUTE_INTERVAL_MS). A failure (of either kind) just keeps the previous
 * `zones`/`hasLoaded` in place and retries next tick — this endpoint takes no request-specific
 * input (no coordinate, no id), so a real permanent rejection isn't a reachable failure mode the
 * way it is for useSurgeAtPoint/useTripEta; every failure here is transient by construction.
 */
export function useSurgeZones(): SurgeZonesState {
  const [zones, setZones] = useState<SurgeZone[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      const result = await getSurgeZones();
      if (cancelled) return;
      if (result.ok) {
        setZones(result.data.zones);
        setHasLoaded(true);
      }
    }

    void poll();
    const timer = setInterval(poll, SURGE_UPDATE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { zones, hasLoaded };
}
