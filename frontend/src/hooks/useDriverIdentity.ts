import { useCallback, useEffect, useState } from "react";
import { createDriver as createDriverApi, describeApiFailure, getDriver } from "../api/client";
import type { CreateDriverInput, Driver } from "../api/types";

const STORAGE_ID_KEY = "ride-tracking.driverId";

export type DriverIdentityState =
  | { status: "checking" }
  | { status: "needs_driver" }
  | { status: "check_failed"; message: string }
  | { status: "ready"; driver: Driver };

export interface CreateDriverOutcome {
  ok: boolean;
  message?: string;
}

/**
 * The driver-side counterpart to useRiderIdentity.ts (Frontend Phase 2) — a minimal
 * "create or select a driver" step gating this view, persisting only the created driverId in
 * localStorage (no real login system here either) and re-verifying it against GET /drivers/:id
 * on every load. Unlike rider identity, the verified `driver` (not just an id/name pair) is kept
 * in state — status in particular is live, mutable backend state (docs/API.md's legal-transition
 * table), so it's always read fresh from the server rather than cached alongside the id.
 */
export function useDriverIdentity(): {
  state: DriverIdentityState;
  createDriver: (input: CreateDriverInput) => Promise<CreateDriverOutcome>;
  refresh: () => void;
} {
  const [state, setState] = useState<DriverIdentityState>({ status: "checking" });
  const [checkVersion, setCheckVersion] = useState(0);

  useEffect(() => {
    const storedId = localStorage.getItem(STORAGE_ID_KEY);
    if (!storedId) {
      setState({ status: "needs_driver" });
      return;
    }

    let cancelled = false;
    setState({ status: "checking" });
    getDriver(storedId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState({ status: "ready", driver: result.data });
        return;
      }
      if (result.reason === "api_error" && result.code === "NOT_FOUND") {
        localStorage.removeItem(STORAGE_ID_KEY);
        setState({ status: "needs_driver" });
        return;
      }
      setState({ status: "check_failed", message: describeApiFailure(result) });
    });

    return () => {
      cancelled = true;
    };
  }, [checkVersion]);

  const createDriver = useCallback(async (input: CreateDriverInput): Promise<CreateDriverOutcome> => {
    const result = await createDriverApi(input);
    if (!result.ok) {
      return { ok: false, message: describeApiFailure(result) };
    }
    localStorage.setItem(STORAGE_ID_KEY, result.data.id);
    setState({ status: "ready", driver: result.data });
    return { ok: true };
  }, []);

  const refresh = useCallback(() => setCheckVersion((v) => v + 1), []);

  return { state, createDriver, refresh };
}
