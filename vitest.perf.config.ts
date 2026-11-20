import { defineConfig } from "vitest/config";

/**
 * Performance-budget project: absolute ceilings and scaling ratios for the hot paths the benches in
 * `packages/core/bench/` report on.
 *
 * It is a separate project for the same reason the E2E suite is: a timing depends on the machine, so
 * `npm test` must never gate on one. `npm run test:perf` does. The budgets are deliberately loose
 * (about 10x a reference laptop); they catch an accidental O(n^2) or a projection that starts
 * copying a transcript, not a few percent of drift.
 */
export default defineConfig({
  test: {
    name: "perf",
    environment: "node",
    include: ["packages/core/test/perf/**/*.test.ts"],
    // A parallel worker would measure a contended CPU. One file, one process, in order.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
