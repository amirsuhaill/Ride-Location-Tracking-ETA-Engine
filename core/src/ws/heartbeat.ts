import type { WebSocket } from "ws";

// Generic ping/pong liveness tracking shared by both driver and subscriber connections — dead
// sockets (peer machine crashed, network dropped without a TCP FIN) never send a WS close frame,
// so without this they'd accumulate as zombie entries in the connection registries forever.
interface Tracked {
  isAlive: boolean;
}

const tracked = new Map<WebSocket, Tracked>();

export function registerHeartbeat(socket: WebSocket): void {
  tracked.set(socket, { isAlive: true });
  socket.on("pong", () => {
    const entry = tracked.get(socket);
    if (entry) entry.isAlive = true;
  });
}

export function unregisterHeartbeat(socket: WebSocket): void {
  tracked.delete(socket);
}

// Exported directly (not just via the interval) so tests can exercise the sweep logic
// deterministically — set a connection's isAlive to false and call this, rather than waiting on
// a real ping/pong round trip over a real network.
export function runHeartbeatSweep(): void {
  for (const [socket, entry] of tracked) {
    if (!entry.isAlive) {
      tracked.delete(socket);
      socket.terminate();
      continue;
    }
    entry.isAlive = false;
    socket.ping();
  }
}

export function isTrackedForTests(socket: WebSocket): boolean {
  return tracked.has(socket);
}

export function markDeadForTests(socket: WebSocket): void {
  const entry = tracked.get(socket);
  if (entry) entry.isAlive = false;
}

let heartbeatTimer: NodeJS.Timeout | undefined;

export function startHeartbeatLoop(intervalMs: number): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(runHeartbeatSweep, intervalMs);
  heartbeatTimer.unref();
}

export function stopHeartbeatLoop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

export function resetHeartbeatForTests(): void {
  tracked.clear();
}
