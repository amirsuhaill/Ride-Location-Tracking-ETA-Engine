import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors";

interface ErrorResponseBody {
  error: { code: string; message: string };
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

// Every error response uses this one shape, whether it's a validation failure, a missing
// entity, an illegal state transition, or an unexpected crash — so API consumers never have to
// branch on error body shape per-route.
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      const body: ErrorResponseBody = { error: { code: err.code, message: err.message } };
      reply.status(err.statusCode).send(body);
      return;
    }

    if (err instanceof ZodError) {
      const body: ErrorResponseBody = {
        error: { code: "VALIDATION_ERROR", message: formatZodError(err) },
      };
      reply.status(400).send(body);
      return;
    }

    request.log.error(err);
    const body: ErrorResponseBody = {
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    };
    reply.status(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorResponseBody = {
      error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found` },
    };
    reply.status(404).send(body);
  });
}
