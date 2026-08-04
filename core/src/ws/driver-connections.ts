import type { WebSocket } from "ws";
import { driverLocationMessageSchema, tripResponseMessageSchema } from "./messages";
import { getWsConfig } from "./runtime-config";
import { registerHeartbeat, unregisterHeartbeat } from "./heartbeat";
import { enqueueLocationUpdate } from "./location-batch";
import { handleDriverResponse } from "./trip-offers";
import { sendJson } from "./util";
import { logger } from "../logger";

interface LocationUpdate {
  lat: number;
  lng: number;
  timestamp: number;
}

interface ThrottleState {
  /** Wall-clock time the last update was actually processed, or null if never. */
  lastProcessedAt: number | null;
  /** Most recent update received during the current throttle window, awaiting flush. */
  pending: LocationUpdate | null;
  flushTimer: NodeJS.Timeout | null;
}

interface DriverConnection {
  socket: WebSocket;
  throttle: ThrottleState;
}

// At most one live connection per driver — see handleDriverConnection's reconnect handling.
const connections = new Map<string, DriverConnection>();

export function getDriverConnectionCount(): number {
  return connections.size;
}

/** Test-only: exposes the exact server-side socket instance for a driver, e.g. to drive the
 * heartbeat sweep test deterministically against the real registered connection object. */
export function getDriverSocketForTests(driverId: string): WebSocket | undefined {
  return connections.get(driverId)?.socket;
}

export function hasDriverConnection(driverId: string): boolean {
  return connections.has(driverId);
}

/** Sends a message directly to a specific driver's own connection (e.g. a trip offer/match
 * confirmation from matching.service.ts) — distinct from subscriptions.ts's broadcast, which is
 * for riders/dispatchers watching a driver, not the driver's own socket. Returns false if the
 * driver has no active connection, so the caller can skip waiting for a response that will
 * never come. */
export function sendToDriver(driverId: string, payload: unknown): boolean {
  const connection = connections.get(driverId);
  if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
  sendJson(connection.socket, payload);
  return true;
}

function clearThrottleTimer(state: ThrottleState): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
}

// Max one update *released* per throttle window; anything else received inside the window is
// coalesced (last-value-wins), not dropped — see docs/websockets.md for the justification. A
// released update doesn't hit Redis/Postgres/broadcast immediately — it's enqueued into the
// fleet-wide batch (src/ws/location-batch.ts), which flushes on its own separate, shorter
// cadence. See docs/ws-batching-and-compression.md for why these are two different, layered
// mechanisms rather than one.
function handleLocationMessage(
  driverId: string,
  state: ThrottleState,
  update: LocationUpdate,
): void {
  const throttleMs = getWsConfig().driverThrottleMs;
  const now = Date.now();
  const sinceLast = state.lastProcessedAt === null ? Infinity : now - state.lastProcessedAt;

  if (sinceLast >= throttleMs) {
    state.lastProcessedAt = now;
    state.pending = null;
    enqueueLocationUpdate(driverId, update);
    return;
  }

  state.pending = update;
  if (!state.flushTimer) {
    const delay = throttleMs - sinceLast;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const toProcess = state.pending;
      state.pending = null;
      if (!toProcess) return;
      state.lastProcessedAt = Date.now();
      enqueueLocationUpdate(driverId, toProcess);
    }, delay);
    state.flushTimer.unref();
  }
}

// Assumes the caller (the WS route handler) has already validated that driverId is a
// syntactically valid UUID belonging to an existing driver.
export function handleDriverConnection(socket: WebSocket, driverId: string): void {
  const existing = connections.get(driverId);
  if (existing) {
    // Reconnect: replace, don't duplicate. This is a deliberate supersede, not a dead-connection
    // detection, so a graceful close is correct here (heartbeat/.terminate() is reserved for
    // connections we can no longer reach at all).
    clearThrottleTimer(existing.throttle);
    unregisterHeartbeat(existing.socket);
    existing.socket.close(4000, "replaced by newer connection");
  }

  const throttle: ThrottleState = { lastProcessedAt: null, pending: null, flushTimer: null };
  connections.set(driverId, { socket, throttle });
  registerHeartbeat(socket);

  sendJson(socket, { type: "connected", driverId });

  socket.on("message", (raw) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      sendJson(socket, { type: "error", message: "malformed JSON payload" });
      return;
    }

    // Location updates have no envelope (see driverLocationMessageSchema) — a trip response is
    // the one other message shape this channel accepts, distinguished by its "type" field.
    const hasType = typeof parsedJson === "object" && parsedJson !== null && "type" in parsedJson;

    if (hasType) {
      const result = tripResponseMessageSchema.safeParse(parsedJson);
      if (!result.success) {
        sendJson(socket, {
          type: "error",
          message: result.error.issues.map((issue) => issue.message).join("; "),
        });
        return;
      }
      handleDriverResponse(result.data.tripId, result.data.accept);
      return;
    }

    const result = driverLocationMessageSchema.safeParse(parsedJson);
    if (!result.success) {
      sendJson(socket, {
        type: "error",
        message: result.error.issues.map((issue) => issue.message).join("; "),
      });
      return;
    }

    handleLocationMessage(driverId, throttle, result.data);
  });

  socket.on("close", () => {
    clearThrottleTimer(throttle);
    unregisterHeartbeat(socket);
    // A reconnect may have already replaced this entry (and closed this socket) before this
    // "close" event for the OLD socket got a chance to fire — don't let the old handler's
    // cleanup delete the NEW connection's registry entry.
    if (connections.get(driverId)?.socket === socket) {
      connections.delete(driverId);
    }
  });

  socket.on("error", (err: unknown) => {
    logger.error({ err, driverId }, "driver websocket error");
  });
}

export function closeAllDriverConnections(): void {
  for (const { socket, throttle } of connections.values()) {
    clearThrottleTimer(throttle);
    unregisterHeartbeat(socket);
    socket.close(1001, "server shutting down");
  }
  connections.clear();
}

export function resetDriverConnectionsForTests(): void {
  for (const { throttle } of connections.values()) {
    clearThrottleTimer(throttle);
  }
  connections.clear();
}
