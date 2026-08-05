import { useEffect, useState } from "react";
import { getHealth } from "../api/client";
import type { HealthResponse } from "../api/types";

/** Re-poll interval for the backend-reachability indicator — frequent enough that a dropped
 * `core` is noticed well within a demo/debugging session, infrequent enough not to spam a
 * dev-only diagnostic endpoint. Matches the same order of magnitude as core's own
 * ETA_RECOMPUTE_INTERVAL_MS-style "short but not per-frame" polling choices elsewhere in this
 * project, not an arbitrary number. */
const POLL_INTERVAL_MS = 10_000;

type Status = { kind: "checking" } | { kind: "reachable"; health: HealthResponse } | { kind: "unreachable" };

export function HealthIndicator() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const result = await getHealth();
      if (cancelled) return;
      setStatus(result.ok ? { kind: "reachable", health: result.data } : { kind: "unreachable" });
    }

    check();
    const timer = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const dotClass =
    status.kind === "reachable"
      ? "bg-green-500"
      : status.kind === "unreachable"
        ? "bg-red-500"
        : "bg-gray-400";

  const label =
    status.kind === "reachable"
      ? `core reachable (v${status.health.version})`
      : status.kind === "unreachable"
        ? "core unreachable"
        : "checking core…";

  return (
    <div className="flex items-center gap-2 text-sm text-gray-600" role="status" aria-live="polite">
      <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
