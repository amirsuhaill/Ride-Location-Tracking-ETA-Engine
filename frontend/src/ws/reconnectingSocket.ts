export type SocketConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export interface ReconnectingSocketHandlers {
  onStateChange?: (state: SocketConnectionState) => void;
  onMessage?: (message: unknown) => void;
}

// Backoff schedule: 500ms, 1s, 2s, 4s, 8s, capped at 10s — a short-but-not-instant first retry
// (a dropped connection is often transient — core restarting, a brief network blip — so retrying
// almost immediately is usually right), doubling from there so a genuinely down backend isn't
// hammered with reconnect attempts, capped at 10s so recovery is still noticed reasonably
// promptly once the backend comes back rather than climbing unboundedly.
const INITIAL_BACKOFF_MS = 500;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 10_000;

/**
 * Shared reconnect-with-backoff lifecycle for this project's WebSocket clients (SubscriberSocket,
 * DriverSocket) — connecting, capped exponential backoff on drop, and explicit teardown
 * (`close()`, never left for garbage collection). Factored out once a second, near-identical
 * implementation made the duplication clear (SubscriberSocket, Frontend Phase 1) rather than
 * pre-emptively — each concrete socket only supplies its own URL (`getUrl`) and whatever it needs
 * to (re)do right after a successful connect (`onOpen`, optional).
 *
 * Heartbeat ping/pong (docs/websockets.md's "Heartbeat" section) needs no application code here
 * at all — the server's `socket.ping()` is a native WebSocket protocol control frame (RFC 6455),
 * and a browser's WebSocket implementation answers it with a pong at the network-stack level,
 * invisible to JavaScript. Nothing for this class to do beyond noticing a drop and reconnecting.
 */
export abstract class ReconnectingSocket {
  private socket: WebSocket | null = null;
  private closedByCaller = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: ReconnectingSocketHandlers;

  constructor(handlers: ReconnectingSocketHandlers) {
    this.handlers = handlers;
  }

  /** The URL to connect (or reconnect) to — a fixed path for SubscriberSocket, a
   * driverId-parameterized one for DriverSocket. */
  protected abstract getUrl(): string;

  /** Called right after a successful 'open' event, before any queued sends — e.g.
   * SubscriberSocket resends its last subscribe request here. A no-op by default. */
  protected onOpen(): void {}

  connect(): void {
    this.closedByCaller = false;
    this.open(false);
  }

  private open(isReconnect: boolean): void {
    this.handlers.onStateChange?.(isReconnect ? "reconnecting" : "connecting");

    const socket = new WebSocket(this.getUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS; // only reset on a real successful connection
      this.handlers.onStateChange?.("connected");
      this.onOpen();
    });

    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return; // malformed frame — nothing this client can do with it
      }
      this.handlers.onMessage?.(parsed);
    });

    socket.addEventListener("close", () => {
      // A stale handler from a socket this instance has already replaced (a fresh reconnect
      // attempt) or explicitly closed — never act on it twice.
      if (this.socket !== socket) return;
      if (this.closedByCaller) return;
      this.scheduleReconnect();
    });

    // 'error' is always followed by 'close' for a browser WebSocket — the close handler above
    // is what actually schedules the reconnect; nothing extra to do here.
    socket.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    this.handlers.onStateChange?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      this.open(true);
    }, this.backoffMs);
  }

  /** Sends a JSON message if currently connected; a no-op otherwise. Whether "not connected right
   * now" needs remembering-to-resend-later is a per-subclass decision (SubscriberSocket
   * remembers its subscription; DriverSocket's location pings are fine to just drop — there's
   * always a fresher one coming). */
  protected send(message: unknown): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /** Explicit teardown — cancels any pending reconnect timer and closes the live socket, rather
   * than leaving either to be cleaned up by garbage collection whenever that happens to run. */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.handlers.onStateChange?.("closed");
  }
}
