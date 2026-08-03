import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Every test file truncates the shared tables in beforeEach against one physical test
    // database — running files in parallel lets one file's truncate wipe rows a concurrently
    // running test in another file depends on. Serial file execution avoids that race.
    fileParallelism: false,
    // Default (non-verbose) reporting swallows console.log from passing tests — the Redis
    // load-shape test's measured timing needs to actually show up in `npm test` output, not just
    // pass an assertion silently.
    reporters: ["verbose"],
  },
});
