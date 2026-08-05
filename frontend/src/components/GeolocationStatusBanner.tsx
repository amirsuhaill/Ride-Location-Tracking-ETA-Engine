import type { GeolocationStatus } from "../hooks/useDriverConnection";

const MESSAGES: Record<GeolocationStatus, { text: string; tone: "info" | "warn" } | null> = {
  idle: null,
  requesting: { text: "Requesting your location…", tone: "info" },
  active: { text: "Sharing your real location.", tone: "info" },
  denied: {
    text: "Location permission was denied. Click anywhere on the map to set your position manually.",
    tone: "warn",
  },
  unsupported: {
    text: "This browser doesn't support geolocation. Click anywhere on the map to set your position manually.",
    tone: "warn",
  },
  error: {
    text: "Couldn't get your location. Click anywhere on the map to set your position manually.",
    tone: "warn",
  },
};

/** Surfaces geolocation permission/availability problems explicitly — never a silently stalled
 * screen — and always points at the manual click-to-set fallback when real Geolocation isn't
 * working. */
export function GeolocationStatusBanner({ status }: { status: GeolocationStatus }) {
  const message = MESSAGES[status];
  if (!message) return null;

  return (
    <p
      role={message.tone === "warn" ? "alert" : "status"}
      className={`text-sm ${message.tone === "warn" ? "text-amber-700" : "text-gray-600"}`}
    >
      {message.text}
    </p>
  );
}
