import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

/**
 * One project per package (the root config globs `packages/*`). Library tests are Node tests; the
 * few component tests opt into jsdom with a `@vitest-environment jsdom` docblock, so the default
 * environment stays fast and honest about what needs a DOM (impl Phase 1).
 */
export default defineConfig({
  plugins: [svelte({ configFile: false }), svelteTesting()],
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
