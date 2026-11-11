import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The Phase 10 kill/restart suite spawns real `argos serve` children; it runs only through
    // `npm run test:e2e` so `npm test` stays fast and process-free.
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
    // The durable suite drives a fake clock and setImmediate flushes; a generous cap keeps a
    // stuck phase observable instead of hanging CI forever.
    testTimeout: 15_000,
  },
});
