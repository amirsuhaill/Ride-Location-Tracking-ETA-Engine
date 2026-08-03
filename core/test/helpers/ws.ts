import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { buildServer, type BuildServerOptions } from "../../src/server";
import { resetDriverConnectionsForTests } from "../../src/ws/driver-connections";
import { resetSubscriptionsForTests } from "../../src/ws/subscriptions";
import { resetHeartbeatForTests } from "../../src/ws/heartbeat";
import { resetLocationBatchForTests } from "../../src/ws/location-batch";
import { resetBandwidthMetricsForTests } from "../../src/ws/bandwidth-metrics";
import { resetTripOffersForTests } from "../../src/ws/trip-offers";

export function makeWsApp(opts: Omit<BuildServerOptions, "logger" | "startBackgroundJobs"> = {}) {
  return buildServer({ ...opts, logger: false, startBackgroundJobs: false });
}

export function resetWsForTests(): void {
  resetDriverConnectionsForTests();
  resetSubscriptionsForTests();
  resetHeartbeatForTests();
  resetLocationBatchForTests();
  resetBandwidthMetricsForTests();
  resetTripOffersForTests();
}

/** A parsed server->client WS message. Fields are read as `unknown` — assert/narrow at the
 * call site (e.g. `m.type === "connected"`, which is a valid comparison against `unknown`). */
export type WsMessage = Record<string, unknown>;

export interface WsClient {
  socket: WebSocket;
  messages: WsMessage[];
  waitForMessage<T extends WsMessage = WsMessage>(
    predicate: (msg: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
}

export async function connectWs(app: FastifyInstance, path: string): Promise<WsClient> {
  const messages: WsMessage[] = [];

  const socket = await app.injectWS(path, undefined, {
    onOpen: (openedSocket) => {
      openedSocket.on("message", (data) => {
        try {
          messages.push(JSON.parse(data.toString()) as WsMessage);
        } catch {
          messages.push({ raw: data.toString() });
        }
      });
    },
  });

  async function waitForMessage<T extends WsMessage = WsMessage>(
    predicate: (msg: T) => boolean,
    timeoutMs = 2000,
  ): Promise<T> {
    const start = Date.now();
    for (;;) {
      const found = messages.find((m) => predicate(m as T));
      if (found !== undefined) return found as T;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `waitForMessage timed out after ${timeoutMs}ms; received so far: ${JSON.stringify(messages)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return { socket, messages, waitForMessage };
}

/** Expects the WS upgrade itself to fail (e.g. a preValidation hook rejecting it). */
export async function expectWsRejection(app: FastifyInstance, path: string): Promise<Error> {
  let socket: WebSocket | undefined;
  try {
    socket = await app.injectWS(path);
  } catch (err) {
    return err as Error;
  }
  socket.terminate();
  throw new Error("expected WS connection to be rejected, but it succeeded");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
