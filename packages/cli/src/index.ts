#!/usr/bin/env node
/**
 * `argos` executable entry (FR25).
 *
 * Executing this file runs the CLI; importing it (tests) only exposes {@link runCli}. `serve` is
 * loaded lazily by the dispatcher so a client command never pulls the durable host into memory.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argosHome } from "argos-core";

import { runCli } from "./main.js";

export { runCli } from "./main.js";

/** Name of the CLI binary. */
export const CLI_NAME = "argos";

/** Small diagnostic used by the Phase 1 smoke test. */
export function describeEnvironment(): string {
  return `${CLI_NAME} home: ${argosHome()}`;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
