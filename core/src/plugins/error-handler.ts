import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors";
import { getFrontendConfig, isApiPath } from "../services/frontend-config";

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
    // A react-router client-side route (e.g. /driver, /dispatcher) has no matching file on disk
    // and would otherwise 404 here on a direct browser navigation/reload — falls back to
    // index.html so client-side routing can take over, exactly like any other SPA deployment
    // (Frontend Phase 10, docs/frontend-deploy.md). Only when the frontend is actually being
    // served at all (`existsSync` — false in local dev/the test suite, where `reply.sendFile`
    // wouldn't even exist since @fastify/static is never registered in that case), and never for
    // a genuinely missing API path, which keeps this project's own real error shape below.
    const frontendConfig = getFrontendConfig();
    if (
      request.method === "GET" &&
      !isApiPath(request.raw.url ?? request.url) &&
      existsSync(frontendConfig.distPath)
    ) {
      reply.type("text/html").sendFile("index.html");
      return;
    }

    const body: ErrorResponseBody = {
      error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found` },
    };
    reply.status(404).send(body);
  });
}
