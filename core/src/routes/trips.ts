import type { FastifyInstance } from "fastify";
import { createTripSchema } from "../schemas/trips";
import { uuidParamSchema } from "../schemas/common";
import * as tripService from "../services/trips.service";
import { matchTrip } from "../services/matching.service";

export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.post("/trips", async (request, reply) => {
    const input = createTripSchema.parse(request.body);
    const trip = await tripService.requestTrip(input);
    reply.code(201).send(trip);

    // Fire-and-forget: matching involves waiting for a driver to accept/decline (up to
    // MATCH_OFFER_TIMEOUT_MS per candidate), which is too slow to hold the HTTP response open
    // for. The rider learns the outcome via their trip subscription over WebSocket (see
    // docs/matching.md) or by polling GET /trips/:id.
    matchTrip(trip.id).catch((err: unknown) => {
      request.log.error({ err, tripId: trip.id }, "matchTrip failed");
    });
  });

  app.get("/trips/:id", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const trip = await tripService.getTrip(id);
    reply.send(trip);
  });
}
