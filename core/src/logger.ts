import pino from "pino";
import { config } from "./config";

/**
 * A process-wide structured logger for every non-request-context service/background module
 * (reconciliation, matching, eta, surge, the WS batch/heartbeat loops) that previously logged via
 * plain `console.error`/`console.warn`/`console.log`. Before Phase 16, request logs were already
 * structured JSON (Fastify's own bundled pino, see server.ts) while everything else was an
 * unstructured string to stdout — two different shapes in the same process's output. Constructed
 * with the exact same options (`{level: config.logLevel}`) Fastify uses for its own internal
 * logger, so both instances emit the identical structured shape
 * (`level`/`time`/`pid`/`hostname`/`msg`) even though they're two separate pino instances rather
 * than one shared object — Fastify 5's `loggerInstance` option has a pino-version type
 * incompatibility with this project's `FastifyInstance` generic that isn't worth fighting for a
 * cosmetic single-object win.
 */
export const logger = pino({ level: config.logLevel });
