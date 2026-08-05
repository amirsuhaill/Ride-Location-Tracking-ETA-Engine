import { useEffect, useRef, useState } from "react";
import { SubscriberSocket, type SubscriberConnectionState } from "../ws/subscriberSocket";
import {
  decodeLocationMessage,
  isLocationBroadcastMessage,
  type LastKnownState,
} from "../ws/deltaCodec";

export interface DriverTrackingState {
  connectionState: SubscriberConnectionState;
  position: LastKnownState | null;
}

/**
 * Owns one /ws/subscribe connection's full lifecycle for a single driverId: opens on mount (or
 * whenever `driverId` changes), decodes every location/delta broadcast into a live position, and
 * closes explicitly on unmount/driverId change — never left for garbage collection (see
 * SubscriberSocket#close). Passing `null` tears down any existing connection without opening a
 * new one, so a component can toggle tracking on/off by just changing what it passes in here.
 */
export function useDriverTracking(driverId: string | null): DriverTrackingState {
  const [connectionState, setConnectionState] = useState<SubscriberConnectionState>("closed");
  const [position, setPosition] = useState<LastKnownState | null>(null);
  const lastKnownRef = useRef<LastKnownState | null>(null);

  useEffect(() => {
    lastKnownRef.current = null;
    setPosition(null);

    if (!driverId) {
      setConnectionState("closed");
      return;
    }

    const socket = new SubscriberSocket({
      onStateChange: setConnectionState,
      onMessage: (message) => {
        if (!isLocationBroadcastMessage(message)) return;
        if (message.driverId !== driverId) return; // defensive — shouldn't happen, one subscription per socket
        const decoded = decodeLocationMessage(lastKnownRef.current, message);
        lastKnownRef.current = decoded;
        setPosition(decoded);
      },
    });

    socket.connect();
    socket.subscribeToDriver(driverId);

    return () => {
      socket.close();
    };
  }, [driverId]);

  return { connectionState, position };
}
