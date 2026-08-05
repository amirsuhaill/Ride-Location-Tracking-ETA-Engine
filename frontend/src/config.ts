/**
 * Base URLs for `core` — resolved one of two ways depending on how this app is actually running,
 * the real resolution to Phase 0's original build-time-vs-runtime gotcha (docs/frontend-deploy.md
 * has the full decision record):
 *
 * 1. **Production** (served by core itself, Frontend Phase 10): `index.html` loads
 *    `/runtime-config.js` — a real route on core, generated fresh per request from core's own
 *    live config — *before* this module (or any of the app's own code) ever runs, setting
 *    `window.__RUNTIME_CONFIG__`. These values are never baked into the JS bundle at
 *    `vite build` time; the exact same built bundle can be pointed at a different `core` by
 *    changing that server's own `PUBLIC_CORE_API_URL`/`PUBLIC_CORE_WS_URL` env vars and
 *    restarting it — no rebuild.
 * 2. **Dev** (`npm run dev`): no core-served `runtime-config.js` exists (Vite's own dev server
 *    doesn't generate one) — falls back to Vite's `import.meta.env`, baked in at dev-server-start
 *    time from `.env`, exactly as every earlier phase's convention already was.
 */
export interface RuntimeConfig {
  coreApiUrl: string;
  coreWsUrl: string;
}

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

function requireEnv(key: keyof ImportMetaEnv): string {
  const value = import.meta.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key} (see .env.example)`);
  }
  return value;
}

function resolveConfig(): RuntimeConfig {
  if (window.__RUNTIME_CONFIG__) return window.__RUNTIME_CONFIG__;

  return {
    coreApiUrl: requireEnv("VITE_CORE_API_URL"),
    coreWsUrl: requireEnv("VITE_CORE_WS_URL"),
  };
}

export const config = resolveConfig();
