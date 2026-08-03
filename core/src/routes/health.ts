import type { FastifyInstance } from "fastify";
import { config } from "../config";

interface HealthResponse {
  status: "ok";
  service: "core";
  uptime: number;
  version: string;
  build: string;
}

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "core",
    uptime: process.uptime(),
    version: config.appVersion,
    build: config.buildVersion,
  }));
}
