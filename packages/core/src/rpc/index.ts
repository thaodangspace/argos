/**
 * `@thaodangspace/argos-core/rpc` — the contract and HTTP client shared by the CLI, the Paseo plugin, and tests.
 *
 * This barrel imports **no durable code**: it is safe in a process that must never open SQLite.
 * The server lives on the separate `@thaodangspace/argos-core/rpc/server` subpath, which only `argos serve`
 * imports (Phase 8 import-graph rule).
 */

export * from "./contracts.js";
export * from "./client.js";
