import { defineConfig } from "vitest/config";

/**
 * Phase 10 end-to-end suite: spawns the built CLI, `SIGKILL`s `argos serve`, and restarts it
 * against the same `$ARGOS_HOME`. It is a separate project so `npm test` stays fast and
 * process-free; `npm run test:e2e` builds first and then runs only this project.
 */
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["packages/core/test/e2e/**/*.test.ts"],
    // Real processes, real SQLite, and at most one `argos serve` per home: never run files in
    // parallel, and give each scenario a bounded but generous budget.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
