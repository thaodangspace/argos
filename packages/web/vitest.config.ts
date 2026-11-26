import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

/**
 * One project per package (the root config globs `packages/*`). Library tests are Node tests; the
 * few component tests opt into jsdom with a `@vitest-environment jsdom` docblock, so the default
 * environment stays fast and honest about what needs a DOM (impl Phase 1).
 *
 * `test/setup.ts` carries the jsdom polyfills Zag.js needs (spec FR19); it guards on `window`, so a
 * Node-environment file imports it and does nothing.
 *
 * `@skeletonlabs/skeleton-svelte` ships **Svelte source**, so it must be inlined into the test
 * module graph: an externalized package is handed to Node's loader, which has no `.svelte` handler
 * (`Unknown file extension ".svelte"`). The production build already compiles it through Vite.
 */
export default defineConfig({
  plugins: [svelte({ configFile: false }), svelteTesting()],
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    server: { deps: { inline: [/@skeletonlabs\/skeleton-svelte/, /@zag-js\/svelte/] } },
  },
});
