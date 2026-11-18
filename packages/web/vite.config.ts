import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

import { UI_BASE } from "./src/lib/base.js";

/**
 * SvelteKit 3 takes its config through the plugin (there is no `svelte.config.js`).
 *
 * - `adapter({ fallback: "index.html" })` makes the build a static SPA: every deep link
 *   (`/ui/runs/<id>`) resolves to the shell, and the core static handler serves the same file for
 *   an extension-less path (spec FR2).
 * - `paths.base = "/ui"` is the only prefix the server reserves for the UI, so it can never collide
 *   with the API route `GET /runs/:id`.
 */
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ fallback: "index.html", strict: false }),
      paths: { base: UI_BASE },
      // Hashes are generated for the shell's inline bootstrap script, so the page can run under a
      // strict policy with no `unsafe-inline` for scripts. The server sends the same policy as a
      // header; the meta tag is what makes the statically served shell work.
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["self"],
          "script-src": ["self"],
          "style-src": ["self", "unsafe-inline"],
          "img-src": ["self", "data:"],
          "connect-src": ["self"],
          "base-uri": ["none"],
          "form-action": ["self"],
          "frame-ancestors": ["none"],
        },
      },
    }),
  ],
  server: {
    // Loopback only, the same stance as `argos serve` (spec NFR Security). Production is served by
    // the core handler; this only affects `vite dev`.
    host: "127.0.0.1",
    port: 5173,
  },
});
