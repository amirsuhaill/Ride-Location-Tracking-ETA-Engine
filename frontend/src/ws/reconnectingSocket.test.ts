import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingSocket, type SocketConnectionState } from "./reconnectingSocket";

/**
 * A minimal, fully test-controlled stand-in for the browser's real WebSocket — no real socket,
 * no real network, no real waiting. Every lifecycle event (open/close/message) only ever fires
 * when a test explicitly calls the matching `trigger*` method, which is what makes the backoff
 * timing below exactly deterministic under fake timers rather than racing real I/O.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sentMessages: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  /** A connection drop — never opened at all (a real down-backend scenario) or dropped after
   * being open; both look the same from this class's perspective, a bare 'close' event. */
  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  triggerMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  /** For deliberately-malformed-frame tests — bypasses the JSON.stringify triggerMessage does,
   * so a real invalid payload reaches the exact same code path a corrupted frame would. */
  triggerRawMessage(raw: string): void {
    this.dispatch("message", { data: raw });
  }

  private dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

class TestSocket extends ReconnectingSocket {
  onOpenCallCount = 0;

  protected getUrl(): string {
    return "ws://test.local/ws";
  }

  protected onOpen(): void {
    this.onOpenCallCount++;
  }

  publicSend(message: unknown): boolean {
    return this.send(message);
  }
}

function latest(): FakeWebSocket {
  const instance = FakeWebSocket.instances.at(-1);
  if (!instance) throw new Error("no FakeWebSocket instance exists yet");
  return instance;
}

describe("ReconnectingSocket", () => {
  let states: SocketConnectionState[];
  let messages: unknown[];
  let socket: TestSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    states = [];
    messages = [];
    socket = new TestSocket({
      onStateChange: (s) => states.push(s),
      onMessage: (m) => messages.push(m),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connect() reports 'connecting' then 'connected' once the real open event fires", () => {
    socket.connect();
    expect(states).toEqual(["connecting"]);
    expect(FakeWebSocket.instances).toHaveLength(1);

    latest().triggerOpen();
    expect(states).toEqual(["connecting", "connected"]);
    expect(socket.onOpenCallCount).toBe(1);
  });

  it("decodes and forwards a real message after connecting", () => {
    socket.connect();
    latest().triggerOpen();
    latest().triggerMessage({ type: "connected", driverId: "d1" });
    expect(messages).toEqual([{ type: "connected", driverId: "d1" }]);
  });

  it("a malformed (non-JSON) frame is dropped, not thrown, and never reaches onMessage", () => {
    socket.connect();
    latest().triggerOpen();
    latest().triggerRawMessage("{not valid json");
    expect(messages).toEqual([]);
  });

  it("send() only actually sends while OPEN, and reports whether it did", () => {
    socket.connect();
    expect(socket.publicSend({ ping: true })).toBe(false); // still just "connecting"

    latest().triggerOpen();
    expect(socket.publicSend({ ping: true })).toBe(true);
    expect(latest().sentMessages).toEqual([JSON.stringify({ ping: true })]);
  });

  it("an unexpected close reports 'reconnecting' and schedules the next attempt at exactly the initial 500ms backoff — not instantly, not never", () => {
    socket.connect();
    latest().triggerOpen();
    states.length = 0; // only care about what happens from the drop onward

    latest().triggerClose();
    expect(states).toEqual(["reconnecting"]);
    expect(FakeWebSocket.instances).toHaveLength(1); // no new attempt yet

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1); // still not yet — this is the exact boundary

    vi.advanceTimersByTime(1); // now at exactly 500ms
    expect(FakeWebSocket.instances).toHaveLength(2); // the real reconnect attempt fires here
  });

  it("the real capped-exponential schedule (500 -> 1000 -> 2000 -> 4000 -> 8000 -> 10000 -> capped at 10000) for consecutive failed attempts, verified with fake timers instead of real sleeps", () => {
    socket.connect();
    latest().triggerClose(); // the very first attempt never even opens — a real "backend is down" case

    const expectedDelays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
    for (const delayMs of expectedDelays) {
      const countBefore = FakeWebSocket.instances.length;
      vi.advanceTimersByTime(delayMs - 1);
      expect(FakeWebSocket.instances).toHaveLength(countBefore); // not yet — one ms early
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(countBefore + 1); // exactly on schedule
      latest().triggerClose(); // this attempt also fails, keeping the failure chain going
    }
    // Real wall-clock cost of exercising the full climb-to-cap schedule above: 0ms — every
    // advance is a fake-timer jump, never a real setTimeout/sleep.
  });

  it("a successful reconnect resets the backoff back to 500ms, rather than continuing to climb", () => {
    socket.connect();
    latest().triggerClose(); // fails once — next attempt scheduled at 500ms

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().triggerOpen(); // this one succeeds — backoff must reset now

    latest().triggerClose(); // drop again after a real successful connection
    const countBefore = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(countBefore); // not yet
    vi.advanceTimersByTime(1); // exactly 500ms again, NOT 1000ms — proves the reset took effect
    expect(FakeWebSocket.instances).toHaveLength(countBefore + 1);
  });

  it("an explicit close() never schedules a reconnect, however long you wait", () => {
    socket.connect();
    latest().triggerOpen();
    states.length = 0;

    socket.close();
    expect(states).toEqual(["closed"]);

    vi.advanceTimersByTime(60_000); // comfortably past every real backoff step, even the cap
    expect(FakeWebSocket.instances).toHaveLength(1); // still just the one, original connection
  });

  it("a stale event from an already-superseded socket is ignored, not treated as a second real drop", () => {
    socket.connect();
    const first = latest();
    first.triggerClose(); // schedules a reconnect

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2); // the real, current attempt
    states.length = 0;

    // A straggler 'close' event arriving late from the OLD, already-replaced socket — this must
    // never fire scheduleReconnect a second time on top of whatever the new socket is doing.
    first.triggerClose();
    expect(states).toEqual([]); // no new state change reported at all
  });
});
