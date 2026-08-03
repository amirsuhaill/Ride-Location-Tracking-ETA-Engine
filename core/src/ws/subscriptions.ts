import type { WebSocket } from "ws";
import type { DriverStatus } from "../schemas/drivers";
import { sendJson } from "./util";
import { encodeLocationMessage, type LastKnownState } from "./delta-compression";
import { recordMessage } from "./bandwidth-metrics";

// Each subscriber socket holds exactly one subscription at a time (by driverId or by tripId) —
// a client that wants to watch multiple drivers opens multiple connections. See
// docs/websockets.md for why this simplification is acceptable at this phase's scope.
interface SubscriberInfo {
  socket: WebSocket;
  driverId: string | null;
  tripId: string | null;
  /** Last ABSOLUTE position + status actually sent to THIS subscriber, or null if none yet —
   * delta compression is per-subscriber (a newly (re)subscribed socket has no prior state to
   * delta against, so its first update is always a full payload). See
   * docs/ws-batching-and-compression.md. */
  lastSent: LastKnownState | null;
}

const subscribersByDriverId = new Map<string, Set<SubscriberInfo>>();
const subscribersByTripId = new Map<string, Set<SubscriberInfo>>();
const subscriberBySocket = new Map<WebSocket, SubscriberInfo>();

function addToIndex<K>(index: Map<K, Set<SubscriberInfo>>, key: K, info: SubscriberInfo): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(info);
}

function removeFromIndex<K>(
  index: Map<K, Set<SubscriberInfo>>,
  key: K,
  info: SubscriberInfo,
): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(info);
  if (set.size === 0) index.delete(key);
}

/** Removes a subscriber from every index it's registered under. Idempotent. */
function detach(info: SubscriberInfo): void {
  if (info.driverId) removeFromIndex(subscribersByDriverId, info.driverId, info);
  if (info.tripId) removeFromIndex(subscribersByTripId, info.tripId, info);
  subscriberBySocket.delete(info.socket);
}

/** A socket may only hold one subscription; subscribing again replaces the previous one. */
function replaceExisting(socket: WebSocket): void {
  const existing = subscriberBySocket.get(socket);
  if (existing) detach(existing);
}

export function subscribeToDriver(socket: WebSocket, driverId: string): void {
  replaceExisting(socket);
  const info: SubscriberInfo = { socket, driverId, tripId: null, lastSent: null };
  addToIndex(subscribersByDriverId, driverId, info);
  subscriberBySocket.set(socket, info);
}

/** driverId is the trip's *currently* assigned driver at subscribe time, or null if unmatched. */
export function subscribeToTrip(socket: WebSocket, tripId: string, driverId: string | null): void {
  replaceExisting(socket);
  const info: SubscriberInfo = { socket, driverId, tripId, lastSent: null };
  addToIndex(subscribersByTripId, tripId, info);
  if (driverId) addToIndex(subscribersByDriverId, driverId, info);
  subscriberBySocket.set(socket, info);
}

export function unsubscribe(socket: WebSocket): boolean {
  const existing = subscriberBySocket.get(socket);
  if (!existing) return false;
  detach(existing);
  return true;
}

export function handleSubscriberDisconnect(socket: WebSocket): void {
  unsubscribe(socket);
}

export interface RawDriverLocationUpdate {
  driverId: string;
  lat: number;
  lng: number;
  timestamp: number;
  status: DriverStatus;
}

function byteLength(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

// Encodes and sends independently per subscriber (each has its own "last position sent" state),
// full on a subscriber's first update and delta-compressed thereafter — see
// docs/ws-batching-and-compression.md. Every send is measured against what a full payload for
// the same data point would have cost, so the cumulative bandwidth-metrics numbers reflect real
// savings, not a guess.
export function broadcastDriverLocation(driverId: string, update: RawDriverLocationUpdate): void {
  const subscribers = subscribersByDriverId.get(driverId);
  if (!subscribers) return;

  const current = { lat: update.lat, lng: update.lng };
  const meta = { driverId: update.driverId, timestamp: update.timestamp, status: update.status };
  const fullPayloadBytes = byteLength({ type: "location", ...current, ...meta });

  for (const info of subscribers) {
    const message = encodeLocationMessage(info.lastSent, current, meta);
    sendJson(info.socket, message);
    recordMessage(fullPayloadBytes, byteLength(message));
    info.lastSent = { ...current, status: update.status };
  }
}

// Called by matching.service.ts once a trip is successfully matched. Trip subscribers who
// subscribed before a driver was assigned (driverId: null at subscribe time — see
// subscribeToTrip above) are re-indexed onto the newly assigned driver so they start receiving
// that driver's location broadcasts, and are sent an explicit notification. This is the
// "notify the rider" half of Phase 6's "notify both parties over WebSocket" — the driver side is
// handled directly in matching.service.ts via driver-connections.ts#sendToDriver.
export function notifyTripMatched(tripId: string, driverId: string): void {
  const subscribers = subscribersByTripId.get(tripId);
  if (!subscribers) return;
  for (const info of subscribers) {
    if (info.driverId !== driverId) {
      if (info.driverId) removeFromIndex(subscribersByDriverId, info.driverId, info);
      info.driverId = driverId;
      addToIndex(subscribersByDriverId, driverId, info);
    }
    sendJson(info.socket, { type: "trip_matched", tripId, driverId });
  }
}

// The real caller for this is whatever marks a trip completed/cancelled (Phase 6's matching
// flow). Exported as a standalone hook now so the mechanism is real and tested even before that
// caller exists — see docs/websockets.md.
export function notifyTripStatusChanged(tripId: string, status: "completed" | "cancelled"): void {
  const subscribers = subscribersByTripId.get(tripId);
  if (!subscribers) return;
  for (const info of Array.from(subscribers)) {
    sendJson(info.socket, { type: "unsubscribed", tripId, reason: `trip_${status}` });
    detach(info);
  }
}

export function getDriverSubscriberCount(driverId: string): number {
  return subscribersByDriverId.get(driverId)?.size ?? 0;
}

export function getTripSubscriberCount(tripId: string): number {
  return subscribersByTripId.get(tripId)?.size ?? 0;
}

export function isSocketSubscribed(socket: WebSocket): boolean {
  return subscriberBySocket.has(socket);
}

export function closeAllSubscriberConnections(): void {
  for (const info of Array.from(subscriberBySocket.values())) {
    detach(info);
    info.socket.close(1001, "server shutting down");
  }
}

export function resetSubscriptionsForTests(): void {
  subscribersByDriverId.clear();
  subscribersByTripId.clear();
  subscriberBySocket.clear();
}
