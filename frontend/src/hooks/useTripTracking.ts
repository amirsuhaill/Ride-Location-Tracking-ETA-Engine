import { useEffect, useRef, useState } from "react";
import { getTrip } from "../api/client";
import { SubscriberSocket, type SubscriberConnectionState } from "../ws/subscriberSocket";
import { applyTripMessage, INITIAL_TRACKING_STATE, type TripTrackingState } from "./tripTrackingReducer";

export type { TripTrackingState } from "./tripTrackingReducer";

/**
 * Drives the rider's view of one trip entirely off real /ws/subscribe messages
 * (`{"type":"subscribe","tripId":...}`, docs/websockets.md) — no GET /trips/:id polling loop.
 * The actual message->state logic lives in tripTrackingReducer.ts (a pure, independently-tested
 * function); this hook is just the React/WebSocket glue around it.
 *
 * One persistent socket lives for this hook's whole mount lifetime (not recreated per tripId);
 * switching tripId explicitly unsubscribes from the old one first (`SubscriberSocket#unsubscribe`)
 * before subscribing to the new one, so a trip the UI no longer cares about never keeps
 * accumulating messages on a subscription nobody's reading anymore.
 *
 * A trip subscription alone is also enough to receive the assigned driver's location broadcasts
 * once matched — core re-indexes the subscriber onto the driver server-side at match time
 * (subscriptions.ts#notifyTripMatched), so no second subscription is ever needed here.
 */
export function useTripTracking(tripId: string | null): {
  connectionState: SubscriberConnectionState;
} & TripTrackingState {
  const [connectionState, setConnectionState] = useState<SubscriberConnectionState>("closed");
  const [tracking, setTracking] = useState<TripTrackingState>(INITIAL_TRACKING_STATE);
  const socketRef = useRef<SubscriberSocket | null>(null);
  const currentTripIdRef = useRef<string | null>(null);
  const trackingRef = useRef<TripTrackingState>(INITIAL_TRACKING_STATE);

  // Dispatches against a ref-tracked current state and calls setTracking with a plain value, not
  // a `prev => ...` updater — a React state updater can be invoked more than once (StrictMode
  // double-invokes updaters in development specifically to catch impure ones), and the
  // "resolve_final_state" effect below fires a real network request; it must not risk running
  // twice for one message.
  function applyMessage(message: unknown): void {
    const { state: next, effect } = applyTripMessage(trackingRef.current, message);
    trackingRef.current = next;
    setTracking(next);
    if (effect.type === "resolve_final_state" && currentTripIdRef.current) {
      const tripId = currentTripIdRef.current;
      void getTrip(tripId).then((result) => {
        if (!result.ok) return;
        const trip = result.data;
        const resolved: TripTrackingState = {
          ...trackingRef.current,
          status: trip.status,
          driverId: trip.driverId,
          cancellationReason: trip.cancellationReason,
        };
        trackingRef.current = resolved;
        setTracking(resolved);
      });
    }
  }

  // One socket for this hook's whole mount lifetime — never recreated just because tripId
  // changes (see the effect below for how a tripId change is handled on the SAME connection).
  useEffect(() => {
    const socket = new SubscriberSocket({
      onStateChange: setConnectionState,
      onMessage: applyMessage,
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    if (currentTripIdRef.current) {
      socket.unsubscribe(); // explicit — never leave the old trip's subscription lingering
    }
    currentTripIdRef.current = tripId;
    trackingRef.current = INITIAL_TRACKING_STATE;
    setTracking(INITIAL_TRACKING_STATE);

    if (tripId) {
      socket.subscribeToTrip(tripId);
    }
  }, [tripId]);

  return { connectionState, ...tracking };
}
