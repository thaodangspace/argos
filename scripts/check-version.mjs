#!/usr/bin/env node
/**
 * Release guard for the npm channel (FR25): a `vX.Y.Z` tag must match every workspace version, the
 * CLI must depend on exactly the core version being published in the same release, and both
 * published packages must be installable (not `private`, not `0.0.0`).
 *
 * The release workflow runs this before `npm publish`; it is also runnable by hand:
 *   node scripts/check-version.mjs v0.1.0
 *   npm run version:check -- v0.1.0
 *
 * The tag argument falls back to `GITHUB_REF_NAME`, but only when Actions is building a tag ref
 * (`GITHUB_REF` under `refs/tags/`). A branch push or a `pull_request` event also sets
 * `GITHUB_REF_NAME` (`main`, `2/merge`), and treating those as tags failed every CI run. With no tag
 * and no workspace version mismatch, only the workspace-level checks run, so
 * `npm run version:check` works on a branch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Workspaces that are published to npm, with the internal dependency each one pins. */
const PUBLISHED = [
  { dir: "packages/core", dependsOn: {} },
  { dir: "packages/cli", dependsOn: { "@thaodangspace/argos-core": null } },
];
/** Workspaces that stay private (installed by path, not by npm). */
const UNPUBLISHED = ["packages/paseo-plugin"];

const readManifest = (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));

/**
 * Actions sets `GITHUB_REF_NAME` for every ref (`v0.1.0`, `main`, `2/merge`), so only a real tag ref
 * may supply the fallback. Outside Actions neither variable is set and an explicit argument is the
 * only way to check a tag.
 */
const refTag = () => {
  const ref = process.env["GITHUB_REF"];
  if (ref !== undefined && !ref.startsWith("refs/tags/")) return undefined;
  return process.env["GITHUB_REF_NAME"] || undefined;
};

const problems = [];
const tag = process.argv[2] ?? refTag() ?? "";
const rootManifest = readManifest(".");
const expected = rootManifest.version;

for (const { dir, dependsOn } of PUBLISHED) {
  const manifest = readManifest(dir);
  const name = manifest.name ?? dir;
  if (manifest.private === true) problems.push(`${name}: still "private": true, npm would refuse it`);
  if (!manifest.version) problems.push(`${name}: no version`);
  if (manifest.version !== expected) {
    problems.push(`${name}: version ${manifest.version} does not match the root version ${expected}`);
  }
  if (manifest.version === "0.0.0") problems.push(`${name}: version 0.0.0 is not publishable`);
  if (manifest.publishConfig?.access !== "public") problems.push(`${name}: publishConfig.access must be "public"`);
  if (!manifest.engines?.node) problems.push(`${name}: no engines.node`);
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    problems.push(`${name}: "files" must include dist`);
  }
  if (!manifest.repository?.url) problems.push(`${name}: no repository.url`);
  for (const [dependency, pin] of Object.entries(dependsOn)) {
    const declared = manifest.dependencies?.[dependency];
    if (declared === undefined) problems.push(`${name}: missing dependency ${dependency}`);
    else if (pin === null && declared !== expected) {
      problems.push(`${name}: ${dependency} is pinned to ${declared}, expected ${expected}`);
    }
  }
}

for (const dir of UNPUBLISHED) {
  const manifest = readManifest(dir);
  if (manifest.private !== true) problems.push(`${manifest.name}: expected "private": true`);
  if (manifest.version !== expected) {
    problems.push(`${manifest.name}: version ${manifest.version} does not match the root version ${expected}`);
  }
}

if (tag && tag !== `v${expected}`) {
  problems.push(`tag ${tag} does not match the workspace version v${expected}`);
}

const cli = readManifest("packages/cli");
if (cli.bin?.["argos"] !== "dist/index.js") problems.push(`${cli.name}: bin.argos must be dist/index.js`);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`version:check: ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `version:check: ${cli.name}@${expected} + @thaodangspace/argos-core@${expected}${tag ? ` (${tag})` : ""} ok\n`,
);
