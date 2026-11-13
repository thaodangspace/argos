#!/usr/bin/env node
/**
 * `argos` executable entry (FR25).
 *
 * Executing this file runs the CLI; importing it (tests) only exposes {@link runCli}. `serve` is
 * loaded lazily by the dispatcher so a client command never pulls the durable host into memory.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argosHome } from "@thaodangspace/argos-core";

import { runCli } from "./main.js";

export { runCli } from "./main.js";

/** Name of the CLI binary. */
export const CLI_NAME = "argos";

/** Small diagnostic used by the Phase 1 smoke test. */
export function describeEnvironment(): string {
  return `${CLI_NAME} home: ${argosHome()}`;
}

/**
 * True when this file is the process entry point. Both paths are realpath'd because a global
 * install (`npm link`, `npm i -g`) runs a bin symlink: `process.argv[1]` keeps the symlink path
 * while `import.meta.url` is the resolved module path, so a plain string compare never matches.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(entry)) === realpathSync(self);
  } catch {
    // `argv[1]` can name a path that no longer exists; fall back to the plain comparison.
    return resolve(entry) === self;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
