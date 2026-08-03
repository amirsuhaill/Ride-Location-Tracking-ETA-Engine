import type { FastifyInstance } from "fastify";
import { createRiderSchema } from "../schemas/riders";
import { uuidParamSchema } from "../schemas/common";
import * as riderService from "../services/riders.service";

export async function riderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/riders", async (request, reply) => {
    const input = createRiderSchema.parse(request.body);
    const rider = await riderService.createRider(input);
    reply.code(201).send(rider);
  });

  app.get("/riders/:id", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const rider = await riderService.getRider(id);
    reply.send(rider);
  });
}
