import type { CancellationReason, TripStatus } from "../api/types";
import { decodeLocationMessage, isLocationBroadcastMessage, type LastKnownState } from "../ws/deltaCodec";

export interface TripTrackingState {
  status: TripStatus;
  driverId: string | null;
  driverPosition: LastKnownState | null;
  cancellationReason: CancellationReason;
}

export const INITIAL_TRACKING_STATE: TripTrackingState = {
  status: "requested",
  driverId: null,
  driverPosition: null,
  cancellationReason: null,
};

/** Tells the caller (useTripTracking) to do a single, targeted GET /trips/:id — never a poll
 * loop — because the WS message just applied doesn't carry enough detail on its own (a specific
 * cancellation reason, or the trip's true final state after an "already ended" race). */
export type TripTrackingEffect = { type: "none" } | { type: "resolve_final_state" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The pure trip-status state machine driving the rider's live view — every documented
 * /ws/subscribe message shape (docs/websockets.md) folded into a state transition, with no
 * WebSocket, timer, or React dependency at all, so it's fully unit-testable (see
 * tripTrackingReducer.test.ts) including the one message this backend build currently has no
 * live trigger for (`unsubscribed` / `reason: "trip_completed"` — see that test file's own
 * doc comment for why).
 */
export function applyTripMessage(
  state: TripTrackingState,
  message: unknown,
): { state: TripTrackingState; effect: TripTrackingEffect } {
  const noEffect = { type: "none" as const };

  if (!isRecord(message)) return { state, effect: noEffect };

  if (message.type === "subscribed") {
    const driverId = typeof message.driverId === "string" ? message.driverId : null;
    if (!driverId) return { state, effect: noEffect };
    return {
      state: {
        ...state,
        status: state.status === "requested" ? "matched" : state.status,
        driverId,
      },
      effect: noEffect,
    };
  }

  if (message.type === "trip_matched") {
    const driverId = typeof message.driverId === "string" ? message.driverId : null;
    return { state: { ...state, status: "matched", driverId }, effect: noEffect };
  }

  if (isLocationBroadcastMessage(message)) {
    if (!state.driverId || message.driverId !== state.driverId) {
      return { state, effect: noEffect }; // a broadcast for some other driver — ignore
    }
    const decoded = decodeLocationMessage(state.driverPosition, message);
    return { state: { ...state, driverPosition: decoded }, effect: noEffect };
  }

  if (message.type === "unsubscribed") {
    if (message.reason === "trip_completed") {
      return { state: { ...state, status: "completed" }, effect: noEffect };
    }
    if (message.reason === "trip_cancelled") {
      // The WS protocol says "cancelled" but not *which* of the two reasons
      // (docs/matching.md) — the caller resolves that with one targeted fetch.
      return { state: { ...state, status: "cancelled" }, effect: { type: "resolve_final_state" } };
    }
    return { state, effect: noEffect }; // "client_requested" — we only ever unsubscribe on purpose
  }

  if (message.type === "error") {
    const text = typeof message.message === "string" ? message.message : "";
    if (/already ended/i.test(text)) {
      // Matching can resolve within milliseconds (docs/surge-pricing.md) — faster than our
      // subscribe message can reach the server in the worst case — so the trip may already be
      // completed/cancelled by the time we subscribe. core refuses new subscriptions to an
      // already-ended trip and returns this generic error instead of "unsubscribed"
      // (docs/websockets.md) — one targeted fetch resolves the real final state.
      return { state, effect: { type: "resolve_final_state" } };
    }
  }

  return { state, effect: noEffect };
}
