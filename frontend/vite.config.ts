/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // Component tests (TripTrackingPanel.test.tsx) render into a real DOM, not just call pure
    // functions — jsdom provides that DOM inside the Node test process, no real browser needed.
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // `e2e/` holds the real, separately-run Playwright suite (playwright.config.ts) — it needs a
    // real running backend and browser, nothing Vitest's fast in-process run should ever touch,
    // and Vitest's default include pattern would otherwise also match its own `*.spec.ts` files.
    exclude: ["node_modules", "e2e/**"],
  },
});
