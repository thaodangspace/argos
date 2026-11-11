#!/usr/bin/env node
/**
 * Post-build: make the CLI entry executable so `bin: {"argos": "dist/index.js"}` works after a
 * plain `npm run build` (tsc preserves the shebang but not the mode bit). No-op when dist is absent.
 */

import { chmodSync } from "node:fs";
import { join } from "node:path";

const entry = join(process.cwd(), "packages", "cli", "dist", "index.js");
try {
  chmodSync(entry, 0o755);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
