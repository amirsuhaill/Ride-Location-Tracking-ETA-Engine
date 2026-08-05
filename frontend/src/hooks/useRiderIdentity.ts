import { useCallback, useEffect, useState } from "react";
import { createRider as createRiderApi, describeApiFailure, getRider } from "../api/client";

const STORAGE_ID_KEY = "ride-tracking.riderId";
const STORAGE_NAME_KEY = "ride-tracking.riderName";

export type RiderIdentityState =
  | { status: "checking" }
  | { status: "needs_rider" }
  | { status: "check_failed"; message: string }
  | { status: "ready"; riderId: string; name: string };

export interface CreateRiderOutcome {
  ok: boolean;
  message?: string;
}

/**
 * A minimal "create or select a rider" step, gating the trip-request flow so POST /trips is
 * never called with a riderId that doesn't exist (docs/API.md's documented 404 case) — handled
 * here, before the request screen, rather than surfacing as a raw API error mid-flow.
 *
 * Persists the created riderId/name in localStorage (a real backend account/session system is
 * out of scope here) and, on every load, re-verifies the stored id against GET /riders/:id — a
 * stale id (e.g. a reset dev database) is caught proactively and routed back to "needs_rider"
 * instead of failing later on the actual trip request.
 */
export function useRiderIdentity(): {
  state: RiderIdentityState;
  createRider: (name: string) => Promise<CreateRiderOutcome>;
  retryCheck: () => void;
} {
  const [state, setState] = useState<RiderIdentityState>({ status: "checking" });
  const [checkVersion, setCheckVersion] = useState(0);

  useEffect(() => {
    const storedId = localStorage.getItem(STORAGE_ID_KEY);
    const storedName = localStorage.getItem(STORAGE_NAME_KEY);
    if (!storedId || !storedName) {
      setState({ status: "needs_rider" });
      return;
    }

    let cancelled = false;
    setState({ status: "checking" });
    getRider(storedId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState({ status: "ready", riderId: storedId, name: storedName });
        return;
      }
      if (result.reason === "api_error" && result.code === "NOT_FOUND") {
        localStorage.removeItem(STORAGE_ID_KEY);
        localStorage.removeItem(STORAGE_NAME_KEY);
        setState({ status: "needs_rider" });
        return;
      }
      setState({
        status: "check_failed",
        message: describeApiFailure(result),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [checkVersion]);

  const createRider = useCallback(async (name: string): Promise<CreateRiderOutcome> => {
    const result = await createRiderApi(name);
    if (!result.ok) {
      return { ok: false, message: describeApiFailure(result) };
    }
    localStorage.setItem(STORAGE_ID_KEY, result.data.id);
    localStorage.setItem(STORAGE_NAME_KEY, result.data.name);
    setState({ status: "ready", riderId: result.data.id, name: result.data.name });
    return { ok: true };
  }, []);

  const retryCheck = useCallback(() => setCheckVersion((v) => v + 1), []);

  return { state, createRider, retryCheck };
}
