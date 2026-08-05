import { useEffect, useState } from "react";
import { onNetworkHealthChange } from "../api/client";

export interface NetworkHealthState {
  /** The browser's own connectivity signal (`navigator.onLine`/`online`/`offline` events) — a
   * real device/OS-level "no network interface is up at all" signal, distinct from "the network
   * is up but core specifically isn't answering." */
  browserOnline: boolean;
  /** False once two consecutive requests have failed to reach core at all (api/client.ts's
   * `onNetworkHealthChange` — a genuine `network_error`, never a mere 4xx/5xx). */
  serverReachable: boolean;
}

/**
 * Combines both real signals a full network-loss condition can show up as (Frontend Phase 8):
 * the browser's own `navigator.onLine` (flips immediately when the OS reports no network
 * interface), and repeated failures to actually reach core (catches the "network interface is up,
 * but core itself/the route to it is down" case `navigator.onLine` alone can't see — `onLine`
 * only reflects local connectivity, not whether any particular remote host is reachable).
 */
export function useNetworkHealth(): NetworkHealthState {
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [serverReachable, setServerReachable] = useState(true);

  useEffect(() => {
    function handleOnline(): void {
      setBrowserOnline(true);
    }
    function handleOffline(): void {
      setBrowserOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const unsubscribe = onNetworkHealthChange(setServerReachable);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      unsubscribe();
    };
  }, []);

  return { browserOnline, serverReachable };
}
