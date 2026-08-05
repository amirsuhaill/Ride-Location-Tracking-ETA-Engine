import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// This project's existing tests import `describe`/`it`/`expect` explicitly rather than relying
// on Vitest's `globals: true` mode (see e.g. deltaCodec.test.ts) — kept consistent here too, which
// means React Testing Library's own auto-cleanup (which only self-registers when it detects
// Jest-style globals) never fires on its own. Unmounting after every test is what actually makes
// component tests independent — without it, each test's rendered output piles up in the same
// jsdom `document.body`, and a later test's `getByText` can suddenly match two elements instead
// of one for a string two different tests both happened to render.
afterEach(() => {
  cleanup();
});
