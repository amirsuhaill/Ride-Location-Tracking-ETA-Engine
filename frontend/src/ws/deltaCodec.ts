import type { DriverStatus } from "../api/types";

/**
 * Mirrors core/src/ws/delta-compression.ts's decode side exactly — same convention this project
 * already uses across a language boundary (ml-service/app/ml/constants.ts mirrors core's own
 * TS constants into Python, documented there as a real, accepted maintenance cost of the split).
 * Here it's the same language but a genuinely separate package (frontend doesn't build against
 * core's internal src/ tree), so the same tradeoff applies: if core's wire format changes, this
 * file needs a matching update.
 */
export const QUANTIZATION_STEP_DEGREES = 1e-5;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LastKnownState extends LatLng {
  status: DriverStatus;
}

export interface FullLocationMessage {
  type: "location";
  driverId: string;
  lat: number;
  lng: number;
  timestamp: number;
  status: DriverStatus;
}

export interface DeltaLocationMessage {
  type: "delta";
  driverId: string;
  dLat: number;
  dLng: number;
  timestamp: number;
  status?: DriverStatus;
}

export type LocationBroadcastMessage = FullLocationMessage | DeltaLocationMessage;

/** Reference decoder — the client-side half of core's encodeLocationMessage/decodeLocationMessage
 * pair. `lastKnown` must be the previously DECODED state (this client's own reconstructed
 * position), not the server's raw last-sent value — the client never sees that. */
export function decodeLocationMessage(
  lastKnown: LastKnownState | null,
  message: LocationBroadcastMessage,
): LastKnownState {
  if (message.type === "location") {
    return { lat: message.lat, lng: message.lng, status: message.status };
  }
  if (!lastKnown) {
    throw new Error("received a delta with no prior full position — dropped message or a bug");
  }
  return {
    lat: lastKnown.lat + message.dLat * QUANTIZATION_STEP_DEGREES,
    lng: lastKnown.lng + message.dLng * QUANTIZATION_STEP_DEGREES,
    status: message.status ?? lastKnown.status,
  };
}

export function isLocationBroadcastMessage(value: unknown): value is LocationBroadcastMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "location" || type === "delta";
}
