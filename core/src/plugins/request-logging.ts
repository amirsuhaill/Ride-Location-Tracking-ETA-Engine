import type { FastifyInstance } from "fastify";

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        path: request.routeOptions.url ?? request.url,
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime * 100) / 100,
      },
      "request completed",
    );
    done();
  });
}
