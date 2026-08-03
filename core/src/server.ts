import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config";
import { healthRoute } from "./routes/health";
import { driverRoutes } from "./routes/drivers";
import { riderRoutes } from "./routes/riders";
import { tripRoutes } from "./routes/trips";
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
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
  });

  if (opts.ws) configureWs(opts.ws);
  if (opts.matching) configureMatching(opts.matching);

  registerErrorHandler(app);
  registerRequestLogging(app);

  // Must be registered before any route using { websocket: true } so it can intercept the
  // upgrade.
  app.register(websocketPlugin);

  app.register(healthRoute);
  app.register(driverRoutes);
  app.register(riderRoutes);
  app.register(tripRoutes);
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
    app.addHook("onClose", (_instance, done) => {
      stopReconciliationJob();
      stopHeartbeatLoop();
      stopBatchLoop();
      stopBandwidthLogLoop();
      done();
    });
  }

  return app;
}
