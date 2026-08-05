import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../api/types";
import { DriverSocket, type DriverConnectionState } from "../ws/driverSocket";
import {
  applyDriverOfferEvent,
  INITIAL_OFFER_PHASE,
  type DriverOfferPhase,
} from "./driverOfferReducer";

/** Mirrors WS_DRIVER_THROTTLE_MS's default (core/.env.example, core/src/config.ts, docs/websockets.md's
 * "Throttling" section). Sending faster than the server's own per-driver throttle accepts is pure
 * waste — the extra messages are coalesced (last-value-wins) server-side, not queued or applied —
 * so there's no benefit to a shorter client interval. Sending slower would leave that server-side
 * allowance unused for no reason. 1000ms also happens to be a plausible real GPS reporting
 * cadence, not just a number picked to match the backend. */
const SEND_THROTTLE_MS = 1000;

export type GeolocationStatus = "idle" | "requesting" | "active" | "denied" | "unsupported" | "error";

export interface DriverConnectionApi {
  connectionState: DriverConnectionState;
  geolocationStatus: GeolocationStatus;
  geolocationErrorMessage: string | null;
  lastSentPosition: LatLng | null;
  /** Manual click-to-set fallback (for desktop dev with no real GPS) — sends immediately,
   * bypassing the continuous-stream throttle above (a deliberate, discrete action, not a
   * continuous stream that needs rate-limiting), but through the exact same
   * `DriverSocket#sendLocation` call the real Geolocation path uses — one send implementation,
   * not two. */
  sendManualPosition: (point: LatLng) => void;
  offerPhase: DriverOfferPhase;
  acceptOffer: () => void;
  declineOffer: () => void;
}

/**
 * Owns the driver's single /ws/driver connection (docs/websockets.md) end to end: sending a real
 * location stream (Geolocation, with an explicit manual fallback — Frontend Phase 4) *and*
 * receiving trip_offer/trip_matched messages on that exact same connection (Frontend Phase 5) —
 * one socket, one owner, both concerns, matching the phase's explicit instruction to extend the
 * existing connection rather than open a second one.
 *
 * Active only while `active` is true (the caller passes `status === "online"`), and torn down
 * completely — the WebSocket, `navigator.geolocation.clearWatch`, and any pending offer
 * deadline/grace timer — the moment it isn't, whether that's the driver going offline or this
 * hook unmounting.
 *
 * The offer state machine (driverOfferReducer.ts) is dispatched through a ref-backed `dispatch`
 * function, not a `setState(prev => ...)` updater — a React state updater can be invoked more
 * than once (StrictMode double-invokes updaters in development specifically to catch impure
 * ones), and `applyDriverOfferEvent`'s effect includes a real side effect
 * (`DriverSocket#sendTripResponse`) that must never fire twice for one accept/decline tap.
 * Computing the transition against a ref and calling `setOfferPhase` with a plain value (not an
 * updater) keeps the actual side effect entirely outside React's state-update machinery.
 */
export function useDriverConnection(driverId: string | null, active: boolean): DriverConnectionApi {
  const [connectionState, setConnectionState] = useState<DriverConnectionState>("closed");
  const [geolocationStatus, setGeolocationStatus] = useState<GeolocationStatus>("idle");
  const [geolocationErrorMessage, setGeolocationErrorMessage] = useState<string | null>(null);
  const [lastSentPosition, setLastSentPosition] = useState<LatLng | null>(null);
  const [offerPhase, setOfferPhase] = useState<DriverOfferPhase>(INITIAL_OFFER_PHASE);

  const socketRef = useRef<DriverSocket | null>(null);
  const lastSentAtRef = useRef(0);
  const offerPhaseRef = useRef<DriverOfferPhase>(INITIAL_OFFER_PHASE);
  const deadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearDeadlineTimer(): void {
    if (deadlineTimerRef.current) {
      clearTimeout(deadlineTimerRef.current);
      deadlineTimerRef.current = null;
    }
  }

  function scheduleDeadlineTimer(phase: DriverOfferPhase): void {
    clearDeadlineTimer();
    if (phase.kind === "offered") {
      const delay = Math.max(0, phase.deadlineMs - Date.now());
      deadlineTimerRef.current = setTimeout(() => dispatchOfferEvent({ type: "deadline_elapsed" }), delay);
    } else if (phase.kind === "responding") {
      const delay = Math.max(0, phase.graceDeadlineMs - Date.now());
      deadlineTimerRef.current = setTimeout(() => dispatchOfferEvent({ type: "grace_elapsed" }), delay);
    }
  }

  function dispatchOfferEvent(
    event: Parameters<typeof applyDriverOfferEvent>[1],
  ): void {
    const { state: next, effect } = applyDriverOfferEvent(offerPhaseRef.current, event);
    offerPhaseRef.current = next;
    setOfferPhase(next);
    scheduleDeadlineTimer(next);
    if (effect.type === "send_trip_response") {
      socketRef.current?.sendTripResponse(effect.tripId, effect.accept);
    }
  }

  useEffect(() => {
    if (!active || !driverId) {
      setConnectionState("closed");
      setGeolocationStatus("idle");
      setGeolocationErrorMessage(null);
      offerPhaseRef.current = INITIAL_OFFER_PHASE;
      setOfferPhase(INITIAL_OFFER_PHASE);
      clearDeadlineTimer();
      return;
    }

    const socket = new DriverSocket(driverId, {
      onStateChange: setConnectionState,
      onMessage: (message) => dispatchOfferEvent({ type: "message", message, nowMs: Date.now() }),
    });
    socketRef.current = socket;
    socket.connect();

    function sendIfDue(point: LatLng): void {
      const now = Date.now();
      if (now - lastSentAtRef.current < SEND_THROTTLE_MS) return;
      lastSentAtRef.current = now;
      socket.sendLocation(point.lat, point.lng);
      setLastSentPosition(point);
    }

    let watchId: number | null = null;
    if (!("geolocation" in navigator)) {
      setGeolocationStatus("unsupported");
    } else {
      setGeolocationStatus("requesting");
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          setGeolocationStatus("active");
          setGeolocationErrorMessage(null);
          sendIfDue({ lat: position.coords.latitude, lng: position.coords.longitude });
        },
        (error) => {
          setGeolocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "error");
          setGeolocationErrorMessage(error.message || "Could not determine your location.");
        },
        { enableHighAccuracy: false, maximumAge: 5000, timeout: 10_000 },
      );
    }

    return () => {
      socket.close();
      socketRef.current = null;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearDeadlineTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatchOfferEvent/scheduleDeadlineTimer close over refs only, stable in effect
  }, [active, driverId]);

  function sendManualPosition(point: LatLng): void {
    lastSentAtRef.current = Date.now();
    socketRef.current?.sendLocation(point.lat, point.lng);
    setLastSentPosition(point);
  }

  return {
    connectionState,
    geolocationStatus,
    geolocationErrorMessage,
    lastSentPosition,
    sendManualPosition,
    offerPhase,
    acceptOffer: () => dispatchOfferEvent({ type: "accept" }),
    declineOffer: () => dispatchOfferEvent({ type: "decline" }),
  };
}
