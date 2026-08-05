import { config } from "../config";
import { ReconnectingSocket, type ReconnectingSocketHandlers, type SocketConnectionState } from "./reconnectingSocket";

export type DriverConnectionState = SocketConnectionState;
export type DriverSocketHandlers = ReconnectingSocketHandlers;

/**
 * A reconnecting client for GET /ws/driver?driverId=<uuid> (docs/websockets.md) — the driver's
 * own location-streaming connection, distinct from SubscriberSocket's read-only
 * /ws/subscribe (a rider/dispatcher watching someone else). Built on the same
 * ReconnectingSocket base (connect/backoff/teardown), since a dropped driver connection needs
 * exactly the same recovery behavior a subscriber does.
 */
export class DriverSocket extends ReconnectingSocket {
  private driverId: string;

  constructor(driverId: string, handlers: DriverSocketHandlers) {
    super(handlers);
    this.driverId = driverId;
  }

  protected getUrl(): string {
    return `${config.coreWsUrl}/ws/driver?driverId=${encodeURIComponent(this.driverId)}`;
  }

  /** Sends a real location update — the exact `{lat,lng,timestamp}` envelope-free shape
   * docs/websockets.md documents, the same one every other driver client in this project sends
   * (core/scripts/load-test-driver-fleet.ts, core/test/matching.test.ts). The single call site
   * both the real Geolocation path and the manual click-to-set fallback funnel through
   * (useDriverLocationStream) — one send implementation, not two. A no-op if not currently
   * connected: dropping one position ping on the floor is fine, there's always a fresher one
   * coming next. */
  sendLocation(lat: number, lng: number): void {
    this.send({ lat, lng, timestamp: Date.now() });
  }

  /** Responds to a trip_offer (docs/matching.md) — the exact `{type,tripId,accept}` shape core
   * expects (core/src/ws/driver-connections.ts). A no-op if not currently connected, same
   * reasoning as sendLocation — though in practice a dropped connection mid-offer means the
   * offer is moot anyway (core would treat the missing response as a timeout/decline). */
  sendTripResponse(tripId: string, accept: boolean): void {
    this.send({ type: "trip_response", tripId, accept });
  }
}
