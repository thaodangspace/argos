import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The durable suite drives a fake clock and setImmediate flushes; a generous cap keeps a
    // stuck phase observable instead of hanging CI forever.
    testTimeout: 15_000,
  },
});
