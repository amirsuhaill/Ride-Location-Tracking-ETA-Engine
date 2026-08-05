/**
 * Base URLs for `core`, read from Vite's `import.meta.env`. Unlike `core`/`ml-service`'s own
 * dotenv-at-process-start config, Vite bakes `VITE_`-prefixed env vars into the built bundle at
 * `vite build` time, not at container/server start — a single production build is tied to
 * whatever `VITE_CORE_API_URL`/`VITE_CORE_WS_URL` were set when it was built. Pointing the same
 * built bundle at a different backend later requires a rebuild, not just changing an env var at
 * deploy time. Flagged here explicitly, not discovered later at Phase 10's deploy step.
 */
function requireEnv(key: keyof ImportMetaEnv): string {
  const value = import.meta.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key} (see .env.example)`);
  }
  return value;
}

export const config = {
  coreApiUrl: requireEnv("VITE_CORE_API_URL"),
  coreWsUrl: requireEnv("VITE_CORE_WS_URL"),
};
