import { useNetworkHealth } from "../hooks/useNetworkHealth";

/**
 * Top-level, app-wide banner (mounted once in AppShell, above every route) for full network loss
 * — a distinct condition from any one screen's own WS "reconnecting…" state (ConnectionStatusBanner)
 * or a single failed request. Two real signals, checked in a stated priority order since both can
 * be true at once: `navigator.onLine` going false is the stronger, more specific claim ("this
 * device has no network at all"), so it's shown in preference to the softer "core specifically
 * isn't answering" signal when both fire together.
 */
export function NetworkStatusBanner() {
  const { browserOnline, serverReachable } = useNetworkHealth();

  if (!browserOnline) {
    return (
      <div role="alert" className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
        You're offline — check your connection. Changes won't be saved until you're back online.
      </div>
    );
  }

  if (!serverReachable) {
    return (
      <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-white">
        Can't reach the server right now — retrying automatically.
      </div>
    );
  }

  return null;
}
