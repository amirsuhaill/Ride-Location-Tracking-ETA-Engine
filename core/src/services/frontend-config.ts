import { config } from "../config";

// Every real API path this server has — anything else, on a GET, is a react-router client-side
// route (e.g. /driver, /dispatcher) with no matching file on disk, not a genuinely missing API
// path (see plugins/error-handler.ts's notFoundHandler, the one place this actually matters).
const API_PATH_PREFIXES = [
  "/health",
  "/internal",
  "/drivers",
  "/riders",
  "/trips",
  "/surge",
  "/ws",
  "/runtime-config.js",
];

export function isApiPath(url: string): boolean {
  return API_PATH_PREFIXES.some(
    (prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`),
  );
}

export interface FrontendRuntimeConfig {
  distPath: string;
  publicCoreApiUrl: string;
  publicCoreWsUrl: string;
}

let runtimeConfig: FrontendRuntimeConfig = {
  distPath: config.frontendDistPath,
  publicCoreApiUrl: config.publicCoreApiUrl,
  publicCoreWsUrl: config.publicCoreWsUrl,
};

/** Overridable for tests — same pattern as configureSurge/configureMatching/configureEta/
 * configureWs: a real test can point this at a real temp directory with a fake built frontend,
 * rather than needing an actual Docker image build just to exercise routes/frontend.ts. */
export function configureFrontend(overrides: Partial<FrontendRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...overrides };
}

export function getFrontendConfig(): FrontendRuntimeConfig {
  return runtimeConfig;
}
