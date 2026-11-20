import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The Phase 10 kill/restart suite spawns real `argos serve` children; it runs only through
    // `npm run test:e2e` so `npm test` stays fast and process-free. The perf budget suite is the same
    // idea for timings: `npm run test:perf` owns it, `npm test` never gates on a wall clock.
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**", "test/perf/**"],
    // The durable suite drives a fake clock and setImmediate flushes; a generous cap keeps a
    // stuck phase observable instead of hanging CI forever.
    testTimeout: 15_000,
    benchmark: {
      // Vite exposes ESM exports through getters, and a bench that calls one millions of times trips
      // Vitest's overhead warning on every run. The overhead is a constant per iteration here (the
      // benches call an imported function once per iteration), so the warning is noise; see
      // `docs/bench.md` for the caveat it stands for.
      suppressExportGetterWarnings: true,
    },
  },
});
