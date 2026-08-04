import type { FastifyInstance } from "fastify";
import { surgeQuerySchema } from "../schemas/surge";
import { getAllSurgeZones, getSurgeMultiplierForLocation } from "../services/surge.service";

export async function surgeRoutes(app: FastifyInstance): Promise<void> {
  // GET /surge            -> every currently-tracked zone (docs/surge-pricing.md)
  // GET /surge?lat=&lng=  -> just the multiplier for the zone covering that point
  app.get("/surge", async (request, reply) => {
    const { lat, lng } = surgeQuerySchema.parse(request.query);

    if (lat !== undefined && lng !== undefined) {
      const multiplier = await getSurgeMultiplierForLocation(lat, lng);
      reply.send({ lat, lng, multiplier });
      return;
    }

    const zones = await getAllSurgeZones();
    reply.send({ zones });
  });
}
