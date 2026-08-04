import type { FastifyInstance } from "fastify";
import { createTripSchema } from "../schemas/trips";
import { uuidParamSchema } from "../schemas/common";
import * as tripService from "../services/trips.service";
import { matchTrip } from "../services/matching.service";
import { getTripEta } from "../services/eta.service";
import { estimateFare } from "../services/fare.service";
import { config } from "../config";

export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.post("/trips", async (request, reply) => {
    const input = createTripSchema.parse(request.body);
    const trip = await tripService.requestTrip(input);
    // Same baseline average speed the heuristic ETA uses (docs/eta.md), factored by the pickup
    // zone's current surge multiplier (docs/surge-pricing.md) — a fresh quote, not persisted.
    const fareEstimate = await estimateFare(
      trip.pickup,
      trip.dropoff,
      config.etaAvgSpeedMetersPerSecond,
    );
    reply.code(201).send({ ...trip, fareEstimate });

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

  // Always 200 — "no driver yet" / "trip completed" / "trip cancelled" / "location too stale to
  // trust" / "ML unavailable" are all valid, meaningful answers to "what's the ETA," not error
  // conditions. See docs/eta.md, docs/eta-integration.md. Only a genuinely unknown tripId is a
  // 404.
  app.get("/trips/:id/eta", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const eta = await getTripEta(id);
    // Observability, not just the response body (Phase 10) — lets a demo/comparison curl the
    // same endpoint under different ETA_MODE values and see which engine actually served each
    // response without parsing JSON.
    reply.header("X-ETA-Source", eta.etaSource ?? "none");
    reply.header(
      "X-ETA-Cache",
      eta.servedFromCache === null ? "n/a" : eta.servedFromCache ? "hit" : "miss",
    );
    reply.send(eta);
  });
}
