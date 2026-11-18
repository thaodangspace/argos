/**
 * The UI is a pure client application: there is no Node runtime behind SvelteKit, so no SSR and no
 * prerender. `argos serve` serves the static build under `/ui` (spec FR7).
 */
export const ssr = false;
export const prerender = false;
