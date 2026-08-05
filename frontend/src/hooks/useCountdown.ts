import { useEffect, useState } from "react";

const TICK_MS = 200;

/**
 * Re-renders periodically so a countdown display reflects real elapsed wall-clock time toward
 * `deadlineMs` — returns the remaining milliseconds (never negative), or `null` when there's no
 * deadline to show. Purely a rendering concern: the actual "has this offer expired" decision
 * lives in driverOfferReducer.ts's own deadline/grace timers, which fire independently of
 * whether this component happens to be mounted or ticking — this hook never drives that logic,
 * only displays it.
 */
export function useCountdown(deadlineMs: number | null): number | null {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (deadlineMs === null) return;
    const interval = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(interval);
  }, [deadlineMs]);

  if (deadlineMs === null) return null;
  return Math.max(0, deadlineMs - Date.now());
}
