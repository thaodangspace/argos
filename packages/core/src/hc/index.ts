/**
 * herdr-core (`hc`) adapter surface (`@thaodangspace/argos-core/hc`).
 *
 * Like `@thaodangspace/argos-core/paseo` and `@thaodangspace/argos-core/durable`, this is a separate subpath so a
 * process opts in explicitly: only `argos serve` may import it (the CLI and the plugin may not,
 * enforced by the import-graph suites). The port types are pure data; `client.ts` is the only
 * module that opens a socket, and nothing here spawns a process.
 */

export * from "./port.js";
export * from "./client.js";
