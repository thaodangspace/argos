/**
 * Paseo adapter surface (`@thaodangspace/argos-core/paseo`).
 *
 * Like `@thaodangspace/argos-core/durable`, this is a separate subpath so a process opts in explicitly. The
 * pure pieces (port types, output schema, catalog, executor) have no SDK dependency; only
 * `client.ts` imports `@getpaseo/client`.
 */

export * from "./port.js";
export * from "./output.js";
export * from "./model-catalog.js";
export * from "./agent-step.js";
export * from "./client.js";
export * from "./fake.js";
