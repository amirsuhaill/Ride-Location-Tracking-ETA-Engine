/// <reference types="vite/client" />

// Augments Vite's own ImportMetaEnv so `import.meta.env.VITE_CORE_API_URL` etc. are typed,
// rather than falling back to `string | undefined` for every unknown key. Vite only exposes env
// vars prefixed `VITE_` to client code (a deliberate security boundary — anything without that
// prefix, e.g. a real secret in .env, never reaches the browser bundle) — see src/config.ts for
// where these are actually read and validated at startup.
interface ImportMetaEnv {
  readonly VITE_CORE_API_URL: string;
  readonly VITE_CORE_WS_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
