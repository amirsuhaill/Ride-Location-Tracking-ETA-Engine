import type { DriverStatus } from "../schemas/drivers";

// Quantization step for delta-encoded lat/lng, in degrees. Chosen for sub-meter-to-~1m precision
// (see docs/ws-batching-and-compression.md for the exact meters-of-error derivation): 1e-5
// degrees of latitude is ~1.11m everywhere; 1e-5 degrees of longitude shrinks with cos(latitude)
// — e.g. ~0.88m at San Francisco's ~37.7°N. Both are already finer than civilian GPS accuracy
// (~3-5m), so this quantization is effectively lossless for a moving vehicle on a rider's map.
export const QUANTIZATION_STEP_DEGREES = 1e-5;

export interface LatLng {
  lat: number;
  lng: number;
}

/** What a subscriber's client is assumed to be tracking: the last reconstructed position plus
 * the last known status — both needed to decode the next message, whichever shape it is. */
export interface LastKnownState extends LatLng {
  status: DriverStatus;
}

export interface FullLocationPayload {
  type: "location";
  driverId: string;
  lat: number;
  lng: number;
  timestamp: number;
  status: DriverStatus;
}

export interface DeltaLocationPayload {
  type: "delta";
  driverId: string;
  dLat: number;
  dLng: number;
  timestamp: number;
  /** Omitted when unchanged since the last message sent to this subscriber — "send only
   * changed fields," applied to status the same way quantized deltas apply to position. A
   * driver's status changes far less often than its position, so this is a real, free
   * bandwidth saving on most delta messages, not just position quantization. */
  status?: DriverStatus;
}

export type LocationBroadcastPayload = FullLocationPayload | DeltaLocationPayload;

interface EncodeMeta {
  driverId: string;
  timestamp: number;
  status: DriverStatus;
}

/**
 * `lastSent` is the last ABSOLUTE (unquantized) position and status this specific subscriber was
 * actually sent — never the previously-quantized/reconstructed value. Always deltaing against
 * the true last position means each hop's rounding error is independent and bounded by
 * ±QUANTIZATION_STEP_DEGREES/2 per axis; it never compounds across a long chain of deltas.
 *
 * `lastSent === null` is the first-update-ever case for this subscriber (a brand new
 * subscription, or one that was just replaced by a resubscribe) — there is nothing to delta
 * against, so a full payload is sent instead of a broken/meaningless delta.
 */
export function encodeLocationMessage(
  lastSent: LastKnownState | null,
  current: LatLng,
  meta: EncodeMeta,
): LocationBroadcastPayload {
  if (!lastSent) {
    return {
      type: "location",
      driverId: meta.driverId,
      lat: current.lat,
      lng: current.lng,
      timestamp: meta.timestamp,
      status: meta.status,
    };
  }

  return {
    type: "delta",
    driverId: meta.driverId,
    dLat: Math.round((current.lat - lastSent.lat) / QUANTIZATION_STEP_DEGREES),
    dLng: Math.round((current.lng - lastSent.lng) / QUANTIZATION_STEP_DEGREES),
    timestamp: meta.timestamp,
    ...(meta.status !== lastSent.status ? { status: meta.status } : {}),
  };
}

/** Reference decoder — this is exactly what a subscriber must do client-side (see
 * docs/ws-batching-and-compression.md). Used by tests and the load-test script to verify
 * round-trip correctness. */
export function decodeLocationMessage(
  lastKnown: LastKnownState | null,
  message: LocationBroadcastPayload,
): LastKnownState {
  if (message.type === "location") {
    return { lat: message.lat, lng: message.lng, status: message.status };
  }
  if (!lastKnown) {
    throw new Error("received a delta with no prior full position — dropped message or client bug");
  }
  return {
    lat: lastKnown.lat + message.dLat * QUANTIZATION_STEP_DEGREES,
    lng: lastKnown.lng + message.dLng * QUANTIZATION_STEP_DEGREES,
    status: message.status ?? lastKnown.status,
  };
}
