import type { LatLng } from "../api/types";

export interface OfferDetails {
  tripId: string;
  pickup: LatLng;
  dropoff: LatLng;
  offerTimeoutMs: number;
}

export type DriverOfferPhase =
  | { kind: "idle" }
  | { kind: "offered"; offer: OfferDetails; deadlineMs: number }
  | { kind: "responding"; offer: OfferDetails; deadlineMs: number; graceDeadlineMs: number }
  | { kind: "expired"; tripId: string; reason: "no_response" | "too_late" }
  | { kind: "declined"; tripId: string }
  | { kind: "matched"; tripId: string; pickup: LatLng; dropoff: LatLng };

export const INITIAL_OFFER_PHASE: DriverOfferPhase = { kind: "idle" };

/**
 * Grace window after the offer's own deadline before concluding an accepted-but-unconfirmed
 * offer was genuinely too late. Real backend behavior (core/src/ws/trip-offers.ts): a late
 * `trip_response` gets **zero feedback** — `handleDriverResponse` just returns `false` and the
 * driver-connections.ts message handler ignores that return value entirely. So the only signal
 * a client has for "did my accept actually land" is whether `trip_matched` arrives at all — this
 * grace period is what turns "nothing happened yet" into an honest, bounded "it didn't happen in
 * time" rather than waiting forever. Covers real round-trip latency for trip_response to reach
 * the server and trip_matched to come back (order of tens of ms on localhost/LAN) with real
 * margin, without leaving the driver hanging indefinitely if something genuinely went wrong.
 */
export const CONFIRMATION_GRACE_MS = 2000;

export type DriverOfferEffect =
  | { type: "none" }
  | { type: "send_trip_response"; tripId: string; accept: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLatLng(value: unknown): value is LatLng {
  return isRecord(value) && typeof value.lat === "number" && typeof value.lng === "number";
}

export type DriverOfferEvent =
  | { type: "message"; message: unknown; nowMs: number }
  | { type: "accept" }
  | { type: "decline" }
  | { type: "deadline_elapsed" }
  | { type: "grace_elapsed" };

const noEffect: DriverOfferEffect = { type: "none" };

/**
 * The pure driver-offer state machine — every documented /ws/driver message shape
 * (docs/matching.md: trip_offer, trip_matched) plus the driver's own accept/decline actions and
 * two synthetic timer events, folded into state transitions with no WebSocket, timer, or React
 * dependency at all (mirrors tripTrackingReducer.ts's approach from Frontend Phase 3). Fully
 * unit-testable, including the exact "accept sent right as the deadline passes" race this phase
 * is about (see driverOfferReducer.test.ts) without needing real network timing.
 */
export function applyDriverOfferEvent(
  state: DriverOfferPhase,
  event: DriverOfferEvent,
): { state: DriverOfferPhase; effect: DriverOfferEffect } {
  if (event.type === "message") {
    const message = event.message;
    if (!isRecord(message)) return { state, effect: noEffect };

    if (message.type === "trip_offer" && state.kind !== "matched") {
      const tripId = typeof message.tripId === "string" ? message.tripId : null;
      const offerTimeoutMs = typeof message.offerTimeoutMs === "number" ? message.offerTimeoutMs : null;
      if (!tripId || offerTimeoutMs === null || !isLatLng(message.pickup) || !isLatLng(message.dropoff)) {
        return { state, effect: noEffect }; // malformed — ignore rather than crash
      }
      const offer: OfferDetails = {
        tripId,
        pickup: message.pickup,
        dropoff: message.dropoff,
        offerTimeoutMs,
      };
      return {
        state: { kind: "offered", offer, deadlineMs: event.nowMs + offerTimeoutMs },
        effect: noEffect,
      };
    }

    if (message.type === "trip_matched") {
      const tripId = typeof message.tripId === "string" ? message.tripId : null;
      if (
        tripId &&
        (state.kind === "offered" || state.kind === "responding") &&
        state.offer.tripId === tripId
      ) {
        return {
          state: { kind: "matched", tripId, pickup: state.offer.pickup, dropoff: state.offer.dropoff },
          effect: noEffect,
        };
      }
      return { state, effect: noEffect };
    }

    return { state, effect: noEffect };
  }

  if (event.type === "accept") {
    if (state.kind !== "offered") return { state, effect: noEffect };
    return {
      state: {
        kind: "responding",
        offer: state.offer,
        deadlineMs: state.deadlineMs,
        graceDeadlineMs: state.deadlineMs + CONFIRMATION_GRACE_MS,
      },
      effect: { type: "send_trip_response", tripId: state.offer.tripId, accept: true },
    };
  }

  if (event.type === "decline") {
    if (state.kind !== "offered") return { state, effect: noEffect };
    return {
      state: { kind: "declined", tripId: state.offer.tripId },
      effect: { type: "send_trip_response", tripId: state.offer.tripId, accept: false },
    };
  }

  if (event.type === "deadline_elapsed") {
    if (state.kind !== "offered") return { state, effect: noEffect };
    return {
      state: { kind: "expired", tripId: state.offer.tripId, reason: "no_response" },
      effect: noEffect,
    };
  }

  if (event.type === "grace_elapsed") {
    if (state.kind !== "responding") return { state, effect: noEffect };
    return {
      state: { kind: "expired", tripId: state.offer.tripId, reason: "too_late" },
      effect: noEffect,
    };
  }

  return { state, effect: noEffect };
}
