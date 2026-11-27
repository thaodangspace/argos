/**
 * `@thaodangspace/argos-core/view` — the shared, DOM-free view model (spec FR6).
 *
 * One implementation of labels, tones, grouping, the step log, history text, the start form, and
 * the Mermaid renderer is imported by the web UI and `argos chart`, so a new history event or
 * status is a single edit. This module must never import the durable host, git,
 * Paseo, hc, the engine, or a Node built-in: `packages/core/test/view/purity.test.ts` enforces it.
 */

export * from "./errors.js";
export * from "./format.js";
export * from "./gates.js";
export * from "./graph.js";
export * from "./labels.js";
export * from "./list.js";
export * from "./run-view.js";
export * from "./start-form.js";
export * from "./step-log.js";
