#!/usr/bin/env node
/**
 * The release switch: one command moves every manifest to the next version, so "merge into main"
 * can mean "publish" (see .github/workflows/release.yml).
 *
 *   node scripts/bump-version.mjs 0.2.0
 *   node scripts/bump-version.mjs v0.2.0
 *   node scripts/bump-version.mjs minor          # patch | minor | major, from the root version
 *   npm run version:bump -- patch
 *
 * Two things make this more than an `npm version`: the repository is a lockstep workspace (root,
 * two published packages, one private one) and every internal pin of `@thaodangspace/argos-core`
 * (CLI, web) must name exactly the version being released. The lockfile embeds the same
 * versions, so the bump ends with `npm install --package-lock-only` unless `--no-lock` is passed;
 * skipping it leaves `npm ci` failing on a fresh checkout, which is what the release workflow runs
 * first.
 *
 * `--dry-run` prints the same lines and writes nothing (the CLI publish test runs it that way).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every manifest that carries the lockstep version. */
const MANIFESTS = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/web/package.json",
];

/** The one internal dependency that is pinned to the exact released version. */
const CORE = "@thaodangspace/argos-core";

const SEMVER = /^\d+\.\d+\.\d+$/;

const fail = (message) => {
  process.stderr.write(`version:bump: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: node scripts/bump-version.mjs <version|patch|minor|major> [--dry-run] [--no-lock]\n",
  );
  process.exit(0);
}

const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const unknown = [...flags].filter((flag) => !["--dry-run", "--no-lock"].includes(flag));
if (unknown.length > 0) fail(`unknown flag ${unknown.join(", ")}`);

const dryRun = flags.has("--dry-run");
const syncLockfile = !flags.has("--no-lock") && !dryRun;
const requested = args.find((argument) => !argument.startsWith("--"));

if (requested === undefined) fail("missing version (e.g. 0.2.0, v0.2.0, patch)");

const readManifest = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const current = readManifest("package.json").version;
if (typeof current !== "string" || !SEMVER.test(current)) {
  fail(`package.json version ${JSON.stringify(current)} is not X.Y.Z`);
}

const next = (() => {
  const keyword = requested.replace(/^v/, "");
  if (["patch", "minor", "major"].includes(keyword)) {
    const [major, minor, patch] = current.split(".").map(Number);
    if (keyword === "major") return `${major + 1}.0.0`;
    if (keyword === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }
  if (!SEMVER.test(keyword)) fail(`${requested} is not a version (X.Y.Z) or patch|minor|major`);
  return keyword;
})();

const lines = [];
/** file -> mutated manifest; written only when not a dry run. */
const writes = new Map();

for (const file of MANIFESTS) {
  const manifest = readManifest(file);
  if (manifest.version === next) continue;
  const from = manifest.version;
  manifest.version = next;
  writes.set(file, manifest);
  lines.push(`version:bump: ${file} ${from} -> ${next}\n`);
}

for (const file of MANIFESTS) {
  const manifest = writes.get(file) ?? readManifest(file);
  const declared = manifest.dependencies?.[CORE];
  if (declared === undefined || declared === next) continue;
  manifest.dependencies[CORE] = next;
  writes.set(file, manifest);
  lines.push(`version:bump: ${file} ${CORE} ${declared} -> ${next}\n`);
}

if (writes.size === 0) {
  process.stdout.write(`version:bump: every manifest is already at ${next}; nothing to do\n`);
  process.exit(0);
}

process.stdout.write(lines.join(""));
process.stdout.write(`version:bump: ${current} -> ${next} (${writes.size} manifest(s))\n`);

if (dryRun) {
  process.stdout.write("version:bump: dry run; nothing written\n");
  process.exit(0);
}

for (const [file, manifest] of writes) {
  writeFileSync(join(root, file), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (syncLockfile) {
  process.stdout.write("version:bump: npm install --package-lock-only\n");
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: root,
    stdio: "inherit",
  });
} else if (!dryRun) {
  process.stdout.write(
    "version:bump: skipped the lockfile; run `npm install --package-lock-only` before committing\n",
  );
}

process.stdout.write(
  `version:bump: next: git commit -am "chore(release): v${next}" && git tag v${next}\n`,
);
