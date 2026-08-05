import { existsSync } from "node:fs";
import staticPlugin from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { logger } from "../logger";
import { getFrontendConfig } from "../services/frontend-config";

/**
 * Serves the built frontend from this same Fastify instance (Frontend Phase 10,
 * docs/frontend-deploy.md) — folded into core rather than a separate static-file container: this
 * removes CORS from the production deployment path entirely (same-origin, by construction) and
 * reuses Fastify's own well-established plugin pattern this project already leans on
 * (`@fastify/cors`, `@fastify/websocket`) rather than standing up new infrastructure for what's
 * ultimately a handful of static files.
 *
 * The actual SPA-fallback ("no matching file -> serve index.html so react-router can take over")
 * lives in `plugins/error-handler.ts`, not here — Fastify only allows one `setNotFoundHandler`
 * per instance/prefix, and that file already owns the project's one real 404 response shape; this
 * module only registers the static file serving and the one new route this phase adds.
 *
 * A no-op if `config.frontendDistPath` doesn't exist — true in local dev and the entire test
 * suite, where no frontend build has ever been copied anywhere near core; nothing here can affect
 * either.
 */
export async function registerFrontend(app: FastifyInstance): Promise<void> {
  const frontendConfig = getFrontendConfig();

  if (!existsSync(frontendConfig.distPath)) {
    logger.info(
      { path: frontendConfig.distPath },
      "frontend dist not found — not serving static assets (expected outside the built Docker image)",
    );
    return;
  }

  await app.register(staticPlugin, { root: frontendConfig.distPath });

  // Generated fresh per request, from this server's own live config/request — never baked into
  // the JS bundle at `vite build` time (Phase 0's original build-time-vs-runtime gotcha;
  // frontend/src/config.ts reads `window.__RUNTIME_CONFIG__` before ever falling back to a
  // build-time value). Left unset, PUBLIC_CORE_API_URL/PUBLIC_CORE_WS_URL derive from the real
  // incoming request's own Host header — correct with zero configuration for the common case
  // (frontend and core served from the same origin) and for a reverse proxy that forwards the
  // real Host, while still overridable to point these exact same built assets at a genuinely
  // different backend, without any rebuild — the actual, demonstrated resolution of that gotcha,
  // not just a design discussed in a doc.
  app.get("/runtime-config.js", async (request, reply) => {
    const host = request.headers.host ?? `localhost:${config.port}`;
    const coreApiUrl = frontendConfig.publicCoreApiUrl || `${request.protocol}://${host}`;
    const coreWsUrl =
      frontendConfig.publicCoreWsUrl || `${request.protocol === "https" ? "wss" : "ws"}://${host}`;

    reply
      .type("application/javascript")
      .send(`window.__RUNTIME_CONFIG__ = ${JSON.stringify({ coreApiUrl, coreWsUrl })};\n`);
  });

  logger.info({ path: frontendConfig.distPath }, "serving frontend static assets");
}
