import { config } from "../config";
import { ReconnectingSocket, type ReconnectingSocketHandlers, type SocketConnectionState } from "./reconnectingSocket";

export type SubscriberConnectionState = SocketConnectionState;
export type SubscriberSocketHandlers = ReconnectingSocketHandlers;

/**
 * A reconnecting client for GET /ws/subscribe (docs/websockets.md) — resubscribing to whatever
 * was last requested once (re)connected, on top of ReconnectingSocket's shared connect/backoff/
 * teardown lifecycle (Frontend Phase 1; Phase 4 factored the lifecycle out into that shared base
 * once DriverSocket needed the identical logic).
 */
export class SubscriberSocket extends ReconnectingSocket {
  private subscribeMessage: Record<string, unknown> | null = null;

  protected getUrl(): string {
    return `${config.coreWsUrl}/ws/subscribe`;
  }

  /** Resends whatever was last subscribed to — this is what makes reconnect automatically
   * resubscribe, with no separate "remember what we wanted" logic needed beyond
   * `subscribeMessage` itself. */
  protected onOpen(): void {
    if (this.subscribeMessage) {
      this.send(this.subscribeMessage);
    }
  }

  subscribeToDriver(driverId: string): void {
    this.setSubscription({ type: "subscribe", driverId });
  }

  /** Same idea as subscribeToDriver, for GET /ws/subscribe's other subscription shape
   * (docs/websockets.md) — a trip subscription also starts receiving that trip's assigned
   * driver's location broadcasts once matched, with no separate driver subscription needed
   * (core re-indexes the subscriber onto the driver at match time, server-side). */
  subscribeToTrip(tripId: string): void {
    this.setSubscription({ type: "subscribe", tripId });
  }

  private setSubscription(message: Record<string, unknown>): void {
    this.subscribeMessage = message;
    this.send(message);
  }

  /** Explicitly ends whatever this socket is currently subscribed to — sent immediately if
   * connected. Also clears the remembered subscription so a later reconnect doesn't resubscribe
   * to something the caller has deliberately moved on from (e.g. switching to a new tripId). */
  unsubscribe(): void {
    this.subscribeMessage = null;
    this.send({ type: "unsubscribe" });
  }
}
