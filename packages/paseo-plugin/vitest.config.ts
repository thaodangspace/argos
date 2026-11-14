import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "paseo-plugin",
    environment: "node",
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "client/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
