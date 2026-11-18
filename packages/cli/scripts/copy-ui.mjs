#!/usr/bin/env node
/**
 * Copy the SvelteKit build into the CLI package (spec FR18).
 *
 * npm only packs files inside the package directory, so the UI cannot be referenced from
 * `packages/web/build` at publish time. This script copies it to `packages/cli/ui/`, writes a
 * `build.json` (so `argos serve` can log which build it is serving), and fails loudly when the UI
 * was never built — a tarball without a UI is a broken `argos serve`, not a warning.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "..", "web", "build");
const target = join(root, "ui");

if (!existsSync(join(source, "index.html"))) {
  console.error(
    "copy-ui: no UI build at packages/web/build/index.html; run `npm run build:ui` first",
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const buildId = createHash("sha256")
  .update(readFileSync(join(target, "index.html")))
  .digest("hex")
  .slice(0, 12);

writeFileSync(
  join(target, "build.json"),
  `${JSON.stringify(
    { buildId, builtAt: new Date().toISOString(), version: manifest.version ?? "0.0.0" },
    null,
    2,
  )}\n`,
);

console.log(`copy-ui: packages/cli/ui (build ${buildId})`);
