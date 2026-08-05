import { describe, expect, it } from "vitest";
import {
  applyDriverOfferEvent,
  CONFIRMATION_GRACE_MS,
  INITIAL_OFFER_PHASE,
  type DriverOfferPhase,
} from "./driverOfferReducer";

const TRIP_ID = "t1111111-1111-1111-1111-111111111111";
const PICKUP = { lat: 37.77, lng: -122.42 };
const DROPOFF = { lat: 37.8, lng: -122.4 };
const NOW = 1_000_000;

function offerMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "trip_offer",
    tripId: TRIP_ID,
    pickup: PICKUP,
    dropoff: DROPOFF,
    offerTimeoutMs: 10_000,
    ...overrides,
  };
}

describe("driverOfferReducer: applyDriverOfferEvent", () => {
  it("a trip_offer message moves idle -> offered with a deadline offerTimeoutMs in the future", () => {
    const { state, effect } = applyDriverOfferEvent(INITIAL_OFFER_PHASE, {
      type: "message",
      message: offerMessage(),
      nowMs: NOW,
    });
    expect(state).toEqual({
      kind: "offered",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
    });
    expect(effect).toEqual({ type: "none" });
  });

  it("a malformed trip_offer (missing offerTimeoutMs) is ignored rather than crashing", () => {
    const message = offerMessage();
    delete (message as Record<string, unknown>).offerTimeoutMs;
    const { state } = applyDriverOfferEvent(INITIAL_OFFER_PHASE, {
      type: "message",
      message,
      nowMs: NOW,
    });
    expect(state).toEqual(INITIAL_OFFER_PHASE);
  });

  it("accepting an offer sends trip_response(accept:true) and moves to 'responding'", () => {
    const offered: DriverOfferPhase = {
      kind: "offered",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
    };
    const { state, effect } = applyDriverOfferEvent(offered, { type: "accept" });
    expect(state).toEqual({
      kind: "responding",
      offer: offered.offer,
      deadlineMs: offered.deadlineMs,
      graceDeadlineMs: offered.deadlineMs + CONFIRMATION_GRACE_MS,
    });
    expect(effect).toEqual({ type: "send_trip_response", tripId: TRIP_ID, accept: true });
  });

  it("declining an offer sends trip_response(accept:false) and moves to 'declined' immediately (no grace wait needed)", () => {
    const offered: DriverOfferPhase = {
      kind: "offered",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
    };
    const { state, effect } = applyDriverOfferEvent(offered, { type: "decline" });
    expect(state).toEqual({ kind: "declined", tripId: TRIP_ID });
    expect(effect).toEqual({ type: "send_trip_response", tripId: TRIP_ID, accept: false });
  });

  it("trip_matched while 'offered' or 'responding' for the same tripId moves to 'matched'", () => {
    const responding: DriverOfferPhase = {
      kind: "responding",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
      graceDeadlineMs: NOW + 12_000,
    };
    const { state, effect } = applyDriverOfferEvent(responding, {
      type: "message",
      message: { type: "trip_matched", tripId: TRIP_ID, driverId: "d1" },
      nowMs: NOW + 500,
    });
    expect(state).toEqual({ kind: "matched", tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF });
    expect(effect).toEqual({ type: "none" });
  });

  it("trip_matched for a DIFFERENT tripId than what's outstanding is ignored", () => {
    const offered: DriverOfferPhase = {
      kind: "offered",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
    };
    const { state } = applyDriverOfferEvent(offered, {
      type: "message",
      message: { type: "trip_matched", tripId: "some-other-trip", driverId: "d1" },
      nowMs: NOW,
    });
    expect(state).toEqual(offered);
  });

  it("the deadline elapsing while still 'offered' (never responded) marks it expired/no_response", () => {
    const offered: DriverOfferPhase = {
      kind: "offered",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
    };
    const { state, effect } = applyDriverOfferEvent(offered, { type: "deadline_elapsed" });
    expect(state).toEqual({ kind: "expired", tripId: TRIP_ID, reason: "no_response" });
    expect(effect).toEqual({ type: "none" });
  });

  it(
    "THE RACE: accept sent right as the deadline passes, and no trip_matched ever arrives — " +
      "the grace deadline elapsing while 'responding' produces an honest expired/too_late state, " +
      "never a false 'matched'",
    () => {
      const offered: DriverOfferPhase = {
        kind: "offered",
        offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
        deadlineMs: NOW + 10_000,
      };
      // Driver taps accept in the last instant before the deadline.
      const afterAccept = applyDriverOfferEvent(offered, { type: "accept" });
      expect(afterAccept.state.kind).toBe("responding");
      expect(afterAccept.effect).toEqual({ type: "send_trip_response", tripId: TRIP_ID, accept: true });

      // The server had already moved on (real behavior: handleDriverResponse silently returns
      // false, docs/matching.md) — no trip_matched ever comes. The grace timer elapses.
      const afterGrace = applyDriverOfferEvent(afterAccept.state, { type: "grace_elapsed" });
      expect(afterGrace.state).toEqual({ kind: "expired", tripId: TRIP_ID, reason: "too_late" });
      expect(afterGrace.effect).toEqual({ type: "none" });
    },
  );

  it("grace_elapsed is a no-op if trip_matched already arrived (state is no longer 'responding')", () => {
    const matched: DriverOfferPhase = {
      kind: "matched",
      tripId: TRIP_ID,
      pickup: PICKUP,
      dropoff: DROPOFF,
    };
    const { state } = applyDriverOfferEvent(matched, { type: "grace_elapsed" });
    expect(state).toEqual(matched);
  });

  it("deadline_elapsed is a no-op once already responding (accept already sent — the grace timer governs that phase, not the original deadline timer)", () => {
    const responding: DriverOfferPhase = {
      kind: "responding",
      offer: { tripId: TRIP_ID, pickup: PICKUP, dropoff: DROPOFF, offerTimeoutMs: 10_000 },
      deadlineMs: NOW + 10_000,
      graceDeadlineMs: NOW + 12_000,
    };
    const { state } = applyDriverOfferEvent(responding, { type: "deadline_elapsed" });
    expect(state).toEqual(responding);
  });

  it("a new trip_offer can start a fresh cycle from 'expired'/'declined' (the driver is available for the next offer)", () => {
    const declined: DriverOfferPhase = { kind: "declined", tripId: TRIP_ID };
    const { state } = applyDriverOfferEvent(declined, {
      type: "message",
      message: offerMessage({ tripId: "t2222222-2222-2222-2222-222222222222" }),
      nowMs: NOW,
    });
    expect(state.kind).toBe("offered");
  });

  it("a trip_offer is ignored while already 'matched' (a busy driver shouldn't be offered a new trip, but is defensively ignored if it happens)", () => {
    const matched: DriverOfferPhase = {
      kind: "matched",
      tripId: TRIP_ID,
      pickup: PICKUP,
      dropoff: DROPOFF,
    };
    const { state } = applyDriverOfferEvent(matched, {
      type: "message",
      message: offerMessage({ tripId: "t3333333-3333-3333-3333-333333333333" }),
      nowMs: NOW,
    });
    expect(state).toEqual(matched);
  });
});
