import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config";
import { healthRoute } from "./routes/health";
import { metricsRoute } from "./routes/metrics";
import { driverRoutes } from "./routes/drivers";
import { riderRoutes } from "./routes/riders";
import { tripRoutes } from "./routes/trips";
import { surgeRoutes } from "./routes/surge";
import { wsRoutes } from "./routes/ws";
import { registerErrorHandler } from "./plugins/error-handler";
import { registerRequestLogging } from "./plugins/request-logging";
import { startReconciliationJob, stopReconciliationJob } from "./services/reconciliation.service";
import { configureWs, type WsRuntimeConfig } from "./ws/runtime-config";
import { startHeartbeatLoop, stopHeartbeatLoop } from "./ws/heartbeat";
import { closeAllDriverConnections } from "./ws/driver-connections";
import { closeAllSubscriberConnections } from "./ws/subscriptions";
import { startBatchLoop, stopBatchLoop } from "./ws/location-batch";
import { startBandwidthLogLoop, stopBandwidthLogLoop } from "./ws/bandwidth-metrics";
import { configureMatching, type MatchingRuntimeConfig } from "./services/matching-config";
import { configureEta, type EtaRuntimeConfig } from "./services/eta-config";
import { configureSurge, type SurgeRuntimeConfig } from "./services/surge-config";
import { startSurgeUpdateLoop, stopSurgeUpdateLoop } from "./services/surge.service";

export interface BuildServerOptions {
  /** Set false to silence logging (used by the test suite). Defaults to config.logLevel. */
  logger?: boolean;
  /**
   * Set false to skip starting the background stale-driver reconciliation job, the WebSocket
   * heartbeat sweep, the location batch-flush loop, and the bandwidth summary log (used by the
   * test suite, which drives all of these directly on its own schedule instead of waiting on
   * real intervals). Defaults to true.
   */
  startBackgroundJobs?: boolean;
  /** Overrides for WS throttle/heartbeat/timestamp-tolerance/batch-window settings (used by tests). */
  ws?: Partial<WsRuntimeConfig>;
  /** Overrides for trip-matching search/offer/scoring settings (used by tests — e.g. a tiny
   * offerTimeoutMs so fallback-on-timeout scenarios run in milliseconds). */
  matching?: Partial<MatchingRuntimeConfig>;
  /** Overrides for ETA speed/throttle/staleness settings (used by tests — e.g. tiny recompute
   * thresholds so throttle behavior is exercised deterministically). */
  eta?: Partial<EtaRuntimeConfig>;
  /** Overrides for surge zone size/bounds/smoothing settings (used by tests — e.g. a tiny
   * minSampleRequests/maxChangePerInterval so scenarios resolve in one or two computeAndUpdateSurge()
   * calls instead of real intervals). */
  surge?: Partial<SurgeRuntimeConfig>;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  // Fastify constructs its own internal pino instance from these exact same options
  // (level: config.logLevel) that src/logger.ts's standalone instance uses for every
  // background/service module below — two instances, but identically configured, so request
  // logs and background-job logs are the same structured JSON shape (level/time/pid/hostname/msg)
  // rather than two different formats. (A single shared instance would be preferable, but
  // Fastify 5's `loggerInstance` option has a pino-version type incompatibility with this
  // project's FastifyInstance generic — not worth fighting for a cosmetic single-object win.)
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
  });

  if (opts.ws) configureWs(opts.ws);
  if (opts.matching) configureMatching(opts.matching);
  if (opts.eta) configureEta(opts.eta);
  if (opts.surge) configureSurge(opts.surge);

  registerErrorHandler(app);
  registerRequestLogging(app);

  // Must be registered before any route using { websocket: true } so it can intercept the
  // upgrade.
  app.register(websocketPlugin);

  app.register(healthRoute);
  app.register(metricsRoute);
  app.register(driverRoutes);
  app.register(riderRoutes);
  app.register(tripRoutes);
  app.register(surgeRoutes);
  app.register(wsRoutes);

  app.addHook("onClose", (_instance, done) => {
    closeAllDriverConnections();
    closeAllSubscriberConnections();
    done();
  });

  if (opts.startBackgroundJobs !== false) {
    startReconciliationJob(config.reconcileIntervalMs);
    startHeartbeatLoop(config.wsHeartbeatIntervalMs);
    startBatchLoop(opts.ws?.batchWindowMs ?? config.wsBatchWindowMs);
    startBandwidthLogLoop(opts.ws?.bandwidthLogIntervalMs ?? config.wsBandwidthLogIntervalMs);
    startSurgeUpdateLoop(opts.surge?.updateIntervalMs ?? config.surgeUpdateIntervalMs);
    app.addHook("onClose", (_instance, done) => {
      stopReconciliationJob();
      stopHeartbeatLoop();
      stopBatchLoop();
      stopBandwidthLogLoop();
      stopSurgeUpdateLoop();
      done();
    });
  }

  return app;
}
