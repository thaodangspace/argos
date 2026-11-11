import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "paseo-plugin",
    environment: "node",
    include: ["src/**/*.test.ts", "*.test.ts"],
  },
});
