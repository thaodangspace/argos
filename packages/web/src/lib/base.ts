/**
 * The one place the UI's base path lives (spec FR1).
 *
 * SvelteKit 3 rewrites `import.meta.env.BASE_URL` to `"./"`, which turns a link built from it into a
 * path relative to the current page (`/ui/runs/x` + `runs/y` → `/ui/runs/runs/y`). The base is a
 * constant of this build, so both `vite.config.ts` and the runtime helpers read it from here.
 */
export const UI_BASE = "/ui";
