import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as driversRepo from "../repositories/drivers.repository";
import * as tripsRepo from "../repositories/trips.repository";
import { handleDriverConnection } from "../ws/driver-connections";
import {
  subscribeToDriver,
  subscribeToTrip,
  unsubscribe,
  handleSubscriberDisconnect,
} from "../ws/subscriptions";
import { clientSubscriptionMessageSchema } from "../ws/messages";
import { registerHeartbeat, unregisterHeartbeat } from "../ws/heartbeat";
import { sendJson } from "../ws/util";
import { logger } from "../logger";

const driverIdQuerySchema = z.object({
  driverId: z.string().uuid("driverId query param must be a valid UUID"),
});

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/ws/driver",
    {
      websocket: true,
      // Runs before the WS upgrade completes — an invalid/unknown driverId fails the upgrade
      // itself (HTTP 400/404), rather than accepting the connection and immediately closing it.
      preValidation: async (request, reply) => {
        const parsed = driverIdQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          await reply.code(400).send({
            error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message },
          });
          return;
        }
        const driver = await driversRepo.findDriverById(parsed.data.driverId);
        if (!driver) {
          await reply.code(404).send({
            error: { code: "NOT_FOUND", message: `Driver ${parsed.data.driverId} not found` },
          });
        }
      },
    },
    (socket, request) => {
      const { driverId } = request.query as { driverId: string };
      handleDriverConnection(socket, driverId);
    },
  );

  app.get("/ws/subscribe", { websocket: true }, (socket) => {
    registerHeartbeat(socket);
    sendJson(socket, { type: "connected" });

    socket.on("message", (raw) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString());
      } catch {
        sendJson(socket, { type: "error", message: "malformed JSON payload" });
        return;
      }

      const result = clientSubscriptionMessageSchema.safeParse(parsedJson);
      if (!result.success) {
        sendJson(socket, {
          type: "error",
          message: result.error.issues.map((issue) => issue.message).join("; "),
        });
        return;
      }

      handleSubscriptionMessage(socket, result.data).catch((err: unknown) => {
        logger.error({ err }, "subscription message handling failed");
      });
    });

    socket.on("close", () => {
      unregisterHeartbeat(socket);
      handleSubscriberDisconnect(socket);
    });

    socket.on("error", (err: unknown) => {
      logger.error({ err }, "subscriber websocket error");
    });
  });
}

async function handleSubscriptionMessage(
  socket: Parameters<typeof subscribeToDriver>[0],
  message: z.infer<typeof clientSubscriptionMessageSchema>,
): Promise<void> {
  if (message.type === "unsubscribe") {
    unsubscribe(socket);
    sendJson(socket, { type: "unsubscribed", reason: "client_requested" });
    return;
  }

  if (message.driverId) {
    const driver = await driversRepo.findDriverById(message.driverId);
    if (!driver) {
      sendJson(socket, { type: "error", message: `Driver ${message.driverId} not found` });
      return;
    }
    subscribeToDriver(socket, message.driverId);
    sendJson(socket, { type: "subscribed", driverId: message.driverId });
    return;
  }

  const tripId = message.tripId as string;
  const trip = await tripsRepo.findTripById(tripId);
  if (!trip) {
    sendJson(socket, { type: "error", message: `Trip ${tripId} not found` });
    return;
  }
  if (trip.status === "completed" || trip.status === "cancelled") {
    sendJson(socket, { type: "error", message: `Trip ${tripId} has already ended` });
    return;
  }
  subscribeToTrip(socket, tripId, trip.driverId);
  sendJson(socket, { type: "subscribed", tripId, driverId: trip.driverId });
}
