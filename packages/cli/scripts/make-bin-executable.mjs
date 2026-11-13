#!/usr/bin/env node
/**
 * Post-build: make the CLI entry executable so `bin: {"argos": "dist/index.js"}` works after a
 * plain `npm run build` (tsc preserves the shebang but not the mode bit). No-op when dist is absent.
 *
 * Resolved from this file, not `process.cwd()`, so it behaves the same whether it runs from the
 * repository root (`npm run build`) or from the package directory (`npm publish -w`, whose
 * `prepublishOnly`/`postbuild` runs with the workspace as cwd).
 */

import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(packageDir, "dist", "index.js");
try {
  chmodSync(entry, 0o755);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
