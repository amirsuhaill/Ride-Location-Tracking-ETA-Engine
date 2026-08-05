import { describe, expect, it } from "vitest";
import { applyTripMessage, INITIAL_TRACKING_STATE, type TripTrackingState } from "./tripTrackingReducer";

const DRIVER_ID = "d1111111-1111-1111-1111-111111111111";
const OTHER_DRIVER_ID = "d2222222-2222-2222-2222-222222222222";
const TRIP_ID = "t1111111-1111-1111-1111-111111111111";

describe("tripTrackingReducer: applyTripMessage", () => {
  it("subscribed with a driverId (already matched at subscribe time) moves 'requested' to 'matched'", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "subscribed",
      tripId: TRIP_ID,
      driverId: DRIVER_ID,
    });
    expect(state.status).toBe("matched");
    expect(state.driverId).toBe(DRIVER_ID);
    expect(effect).toEqual({ type: "none" });
  });

  it("subscribed with driverId: null (not yet matched) leaves status untouched", () => {
    const { state } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "subscribed",
      tripId: TRIP_ID,
      driverId: null,
    });
    expect(state).toEqual(INITIAL_TRACKING_STATE);
  });

  it("trip_matched sets status to matched and records the driverId", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "trip_matched",
      tripId: TRIP_ID,
      driverId: DRIVER_ID,
    });
    expect(state.status).toBe("matched");
    expect(state.driverId).toBe(DRIVER_ID);
    expect(effect).toEqual({ type: "none" });
  });

  it("a full 'location' message for the tracked driver sets driverPosition", () => {
    const matched: TripTrackingState = { ...INITIAL_TRACKING_STATE, status: "matched", driverId: DRIVER_ID };
    const { state } = applyTripMessage(matched, {
      type: "location",
      driverId: DRIVER_ID,
      lat: 37.77,
      lng: -122.42,
      timestamp: 1,
      status: "online",
    });
    expect(state.driverPosition).toEqual({ lat: 37.77, lng: -122.42, status: "online" });
  });

  it("a location broadcast for a DIFFERENT driverId is ignored (state unchanged)", () => {
    const matched: TripTrackingState = { ...INITIAL_TRACKING_STATE, status: "matched", driverId: DRIVER_ID };
    const { state } = applyTripMessage(matched, {
      type: "location",
      driverId: OTHER_DRIVER_ID,
      lat: 1,
      lng: 1,
      timestamp: 1,
      status: "online",
    });
    expect(state).toEqual(matched);
  });

  it("a delta message decodes against the previously stored driverPosition", () => {
    const withPosition: TripTrackingState = {
      ...INITIAL_TRACKING_STATE,
      status: "matched",
      driverId: DRIVER_ID,
      driverPosition: { lat: 37.77, lng: -122.42, status: "online" },
    };
    const { state } = applyTripMessage(withPosition, {
      type: "delta",
      driverId: DRIVER_ID,
      dLat: 100,
      dLng: -100,
      timestamp: 2,
    });
    expect(state.driverPosition?.lat).toBeCloseTo(37.77 + 100 * 1e-5, 10);
    expect(state.driverPosition?.lng).toBeCloseTo(-122.42 - 100 * 1e-5, 10);
    expect(state.driverPosition?.status).toBe("online"); // carried forward, delta omitted it
  });

  it("unsubscribed/trip_completed marks the trip completed with no follow-up fetch needed", () => {
    const matched: TripTrackingState = { ...INITIAL_TRACKING_STATE, status: "matched", driverId: DRIVER_ID };
    const { state, effect } = applyTripMessage(matched, {
      type: "unsubscribed",
      tripId: TRIP_ID,
      reason: "trip_completed",
    });
    expect(state.status).toBe("completed");
    expect(effect).toEqual({ type: "none" });
  });

  it("unsubscribed/trip_cancelled marks the trip cancelled AND signals a follow-up fetch (the WS message doesn't carry which cancellation reason)", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "unsubscribed",
      tripId: TRIP_ID,
      reason: "trip_cancelled",
    });
    expect(state.status).toBe("cancelled");
    expect(effect).toEqual({ type: "resolve_final_state" });
  });

  it("unsubscribed/client_requested (we only ever unsubscribe on purpose ourselves) is a no-op here", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "unsubscribed",
      reason: "client_requested",
    });
    expect(state).toEqual(INITIAL_TRACKING_STATE);
    expect(effect).toEqual({ type: "none" });
  });

  it("an 'already ended' error (the subscribe-vs-instant-resolution race) signals a follow-up fetch without guessing the outcome", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "error",
      message: `Trip ${TRIP_ID} has already ended`,
    });
    expect(state).toEqual(INITIAL_TRACKING_STATE); // no guess at status — the fetch will resolve it
    expect(effect).toEqual({ type: "resolve_final_state" });
  });

  it("an unrelated error message (e.g. a validation error) has no effect", () => {
    const { state, effect } = applyTripMessage(INITIAL_TRACKING_STATE, {
      type: "error",
      message: "Trip abc not found",
    });
    expect(state).toEqual(INITIAL_TRACKING_STATE);
    expect(effect).toEqual({ type: "none" });
  });

  it("a non-object message (malformed/unexpected) never throws and leaves state untouched", () => {
    expect(applyTripMessage(INITIAL_TRACKING_STATE, null).state).toEqual(INITIAL_TRACKING_STATE);
    expect(applyTripMessage(INITIAL_TRACKING_STATE, "oops").state).toEqual(INITIAL_TRACKING_STATE);
    expect(applyTripMessage(INITIAL_TRACKING_STATE, 42).state).toEqual(INITIAL_TRACKING_STATE);
  });
});
