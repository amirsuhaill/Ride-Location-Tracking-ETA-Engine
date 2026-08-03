import type { FastifyInstance } from "fastify";
import {
  createDriverSchema,
  patchDriverStatusSchema,
  patchDriverLocationSchema,
  nearbyQuerySchema,
} from "../schemas/drivers";
import { uuidParamSchema } from "../schemas/common";
import * as driverService from "../services/drivers.service";

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  app.post("/drivers", async (request, reply) => {
    const input = createDriverSchema.parse(request.body);
    const driver = await driverService.createDriver(input);
    reply.code(201).send(driver);
  });

  // Registered ahead of "/drivers/:id" for readability; Fastify's router already prioritizes
  // static path segments over parametric ones regardless of registration order.
  app.get("/drivers/nearby", async (request, reply) => {
    const { lat, lng, radius, limit } = nearbyQuerySchema.parse(request.query);
    const drivers = await driverService.searchNearbyDrivers(lat, lng, radius, limit);
    reply.send({ drivers });
  });

  app.get("/drivers/:id", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const driver = await driverService.getDriver(id);
    reply.send(driver);
  });

  app.patch("/drivers/:id/status", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const { status } = patchDriverStatusSchema.parse(request.body);
    const driver = await driverService.updateDriverStatus(id, status);
    reply.send(driver);
  });

  app.patch("/drivers/:id/location", async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const { lat, lng } = patchDriverLocationSchema.parse(request.body);
    const driver = await driverService.updateDriverLocation(id, lat, lng);
    reply.send(driver);
  });
}
