import type { SocketConnectionState } from "../ws/reconnectingSocket";

const MESSAGES: Record<SocketConnectionState, { text: string; tone: "info" | "warn" } | null> = {
  connecting: { text: "Connecting…", tone: "info" },
  connected: null,
  // The one state Frontend Phase 8 is actually about — ReconnectingSocket is already retrying
  // with real capped-exponential backoff (500ms → 1s → 2s → 4s → 8s → capped at 10s,
  // ws/reconnectingSocket.ts) and will automatically resubscribe once it lands; this is purely
  // the "let the person watching know that's happening" half of that.
  reconnecting: { text: "Reconnecting… your connection was interrupted.", tone: "warn" },
  closed: null,
};

/**
 * Surfaces a dropped-then-recovering WebSocket connection explicitly, the same
 * role/tone/aria-live convention GeolocationStatusBanner already established (Frontend Phase 4)
 * — never a silently frozen screen while ReconnectingSocket works in the background. Renders
 * nothing for "connected" (the common case — silence is the right amount of chrome when
 * everything's fine) or "closed" (often intentional, e.g. a driver going offline; a caller that
 * wants "closed" to mean something distinct on its own screen renders that itself).
 */
export function ConnectionStatusBanner({ state }: { state: SocketConnectionState }) {
  const message = MESSAGES[state];
  if (!message) return null;

  return (
    <p
      role={message.tone === "warn" ? "alert" : "status"}
      className={`text-sm ${message.tone === "warn" ? "font-medium text-amber-700" : "text-gray-500"}`}
    >
      {message.text}
    </p>
  );
}
