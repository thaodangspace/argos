/**
 * The npm channel (FR25): `npm i -g @thaodangspace/argos` must keep working, so the two published
 * manifests, their lockstep versions, the licence files npm packs next to `dist`, and the release
 * guard (scripts/check-version.mjs) are all contracts, not conventions.
 *
 * The plugin stays private on purpose: Paseo installs it from a checkout (`server/`, `shared/`,
 * `client/`, `*.tsx`), so it is not part of the npm surface.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly engines?: { readonly node?: string };
  readonly files?: readonly string[];
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly url?: string; readonly directory?: string };
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
}

const manifest = (directory: string): Manifest =>
  JSON.parse(readFileSync(join(repoRoot, directory, "package.json"), "utf8")) as Manifest;

const root = manifest(".");
const core = manifest("packages/core");
const cli = manifest("packages/cli");
const plugin = manifest("packages/paseo-plugin");
const web = manifest("packages/web");
const published = [core, cli];

describe("npm package manifests", () => {
  it("keeps the whole repo on one publishable version", () => {
    const version = root.version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toBe("0.0.0");
    for (const packageManifest of [core, cli, plugin, web]) {
      expect(packageManifest.version, packageManifest.name).toBe(version);
    }
  });

  it("publishes core and the CLI, and pins core to the shipped version", () => {
    expect(core.name).toBe("@thaodangspace/argos-core");
    expect(cli.name).toBe("@thaodangspace/argos");
    expect(cli.dependencies?.["@thaodangspace/argos-core"]).toBe(core.version);
    expect(plugin.dependencies?.["@thaodangspace/argos-core"]).toBe(core.version);
    expect(plugin.private).toBe(true);
    // The UI is an implementation detail of `argos serve`, shipped inside the CLI tarball.
    expect(web.name).toBe("@thaodangspace/argos-web");
    expect(web.private).toBe(true);
  });

  it.each(published)("gives $name publishable metadata", (packageManifest) => {
    expect(packageManifest.private).toBeUndefined();
    expect(packageManifest.publishConfig?.access).toBe("public");
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.engines?.node).toBe(">=22.13");
    expect(packageManifest.files).toContain("dist");
    expect(packageManifest.repository?.url).toContain("github.com/thaodangspace/argos");
    // The CLI also copies the SvelteKit build into `ui/` before publishing (spec FR18).
    expect(packageManifest.scripts?.["prepublishOnly"]).toContain("npm run build");
  });

  it("syncs the SvelteKit toolchain on install", () => {
    // `npm ci` runs workspace `prepare` scripts; without it `$app/tsconfig` (generated into
    // `packages/web/node_modules/$app/tsconfig.json`) does not exist, and the web test project
    // fails to transform on a fresh checkout.
    expect(web.scripts?.["prepare"]).toContain("svelte-kit sync");
  });

  it("ships the UI inside the CLI tarball", () => {
    expect(cli.files).toContain("ui");
    expect(existsSync(join(repoRoot, "packages/cli/scripts/copy-ui.mjs"))).toBe(true);
    expect(cli.scripts?.["prepublishOnly"]).toContain("copy-ui.mjs");
    expect(root.scripts?.["release:publish"]).toContain("build:ui");
    expect(root.scripts?.["build:ui"]).toContain("argos-web");
  });

  it("points the CLI bin at the built entry", () => {
    expect(cli.bin?.["argos"]).toBe("dist/index.js");
  });

  it("ships a README and the repository licence with each published package", () => {
    const licence = readFileSync(join(repoRoot, "LICENSE"), "utf8");
    for (const directory of ["packages/core", "packages/cli"]) {
      const readme = join(repoRoot, directory, "README.md");
      expect(existsSync(readme), readme).toBe(true);
      expect(readFileSync(join(repoRoot, directory, "LICENSE"), "utf8"), directory).toBe(licence);
    }
  });

  it("has a release workflow that publishes on a version bump and on a tag", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    // A merge into main publishes only when the embedded version is not on npm yet, so the bump is
    // the release switch; a `v*` tag re-runs or repairs the same release.
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("npm run version:bump");

    const corePublish = workflow.indexOf("npm publish -w @thaodangspace/argos-core");
    const cliPublish = workflow.indexOf("npm publish -w @thaodangspace/argos ");
    expect(corePublish).toBeGreaterThan(-1);
    expect(cliPublish).toBeGreaterThan(corePublish);
    expect(workflow).toContain("--provenance");
    expect(workflow).toContain("scripts/check-version.mjs");
  });

  it("builds the UI before the CLI publish can pack it", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    // `packages/cli` has `prepublishOnly: npm run build && node scripts/copy-ui.mjs`, so publishing
    // without a `packages/web/build` first fails *after* core is live: a half-finished release.
    const buildUi = workflow.indexOf("npm run build:ui");
    const cliPublish = workflow.indexOf("npm publish -w @thaodangspace/argos ");
    expect(buildUi).toBeGreaterThan(-1);
    expect(buildUi).toBeLessThan(cliPublish);
    expect(workflow.indexOf("copy-ui.mjs")).toBeLessThan(cliPublish);
  });

  it("gates a publish, skips a no-op push, and verifies what landed on npm", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    // Human gate between merge and publish, and the writes a publish and a release need.
    expect(workflow).toContain("environment: npm-publish");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: write");
    // The registry probe decides whether anything runs, so a no-op merge never asks for approval.
    expect(workflow).toContain("--prefer-online");
    expect(workflow).toContain("needs.resolve.outputs.enabled == 'true'");
    // A half-published release (core live, CLI missing) publishes the missing side.
    expect(workflow).toContain("publish_core");
    expect(workflow).toContain("publish_cli");
    // Auth must not be a long-lived secret: only export NODE_AUTH_TOKEN when NPM_TOKEN exists, so
    // npm 11 can fall back to OIDC trusted publishing instead of an empty credential.
    expect(workflow).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("export NODE_AUTH_TOKEN=\"$NPM_TOKEN\"");
    // Registry propagation lags; the release asset is the tarball npm actually published.
    expect(workflow).toContain("dist.integrity");
    expect(workflow).toContain("gh release create");
  });
});

describe("scripts/check-version.mjs", () => {
  const run = (
    args: string[],
    env: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } => {
    try {
      const stdout = execFileSync(process.execPath, [join(repoRoot, "scripts", "check-version.mjs"), ...args], {
        cwd: repoRoot,
        env: { ...process.env, GITHUB_REF: "", GITHUB_REF_NAME: "", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  };

  it("accepts a tag that matches the workspace version", () => {
    const result = run([`v${root.version}`]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`@thaodangspace/argos@${root.version}`);
  });

  it("refuses a tag that does not match", () => {
    const result = run(["v9.9.9"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the workspace version");
  });

  it("accepts a branch run with no tag", () => {
    expect(run([]).status).toBe(0);
  });

  // `GITHUB_REF_NAME` is `main` on a branch push and `2/merge` on a pull_request event. Reading
  // either as a tag failed the `test` workflow on every run (a tag ref is the only one that names a
  // release).
  it.each([
    ["a branch push", { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }],
    ["a pull_request merge ref", { GITHUB_REF: "refs/pull/2/merge", GITHUB_REF_NAME: "2/merge" }],
  ])("ignores GITHUB_REF_NAME on %s", (_label, env) => {
    const result = run([], env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("main");
  });

  it("reads the tag from GITHUB_REF_NAME on a tag ref", () => {
    const result = run([], { GITHUB_REF: `refs/tags/v${root.version}`, GITHUB_REF_NAME: `v${root.version}` });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`(v${root.version})`);
  });

  it("refuses a tag ref that does not match", () => {
    const result = run([], { GITHUB_REF: "refs/tags/v9.9.9", GITHUB_REF_NAME: "v9.9.9" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tag v9.9.9 does not match the workspace version");
  });
});

describe("scripts/bump-version.mjs", () => {
  const bump = (args: string[]): { status: number; stdout: string; stderr: string } => {
    try {
      const stdout = execFileSync(
        process.execPath,
        [join(repoRoot, "scripts", "bump-version.mjs"), ...args],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  };

  // The release switch: "merge into main publishes" is only true when one command moves the whole
  // lockstep graph, including every internal pin of the core package.
  it("moves every manifest and every core pin, writing nothing on a dry run", () => {
    const before = [".", "packages/core", "packages/cli", "packages/paseo-plugin", "packages/web"].map(
      (directory) => readFileSync(join(repoRoot, directory, "package.json"), "utf8"),
    );

    const result = bump(["0.0.0-test.dry-run", "--dry-run"]);
    expect(result.stderr).toContain("is not a version");
    expect(result.status).toBe(1);

    const next = `${Number(root.version?.split(".")[0]) + 1}.0.0`;
    const planned = bump([next, "--dry-run"]);
    expect(planned.status).toBe(0);
    for (const directory of [".", "packages/core", "packages/cli", "packages/paseo-plugin", "packages/web"]) {
      expect(planned.stdout).toContain(`version:bump: ${directory === "." ? "package.json" : `${directory}/package.json`}`);
    }
    expect(planned.stdout).toContain(`packages/cli/package.json @thaodangspace/argos-core`);
    expect(planned.stdout).toContain(`packages/paseo-plugin/package.json @thaodangspace/argos-core`);
    expect(planned.stdout).toContain(`packages/web/package.json @thaodangspace/argos-core`);
    expect(planned.stdout).toContain("dry run; nothing written");

    const after = [".", "packages/core", "packages/cli", "packages/paseo-plugin", "packages/web"].map(
      (directory) => readFileSync(join(repoRoot, directory, "package.json"), "utf8"),
    );
    expect(after).toEqual(before);
  });

  it("accepts patch, minor, and major relative to the current version", () => {
    const [major = 0, minor = 0, patch = 0] = (root.version ?? "0.0.0").split(".").map(Number);
    expect(bump(["patch", "--dry-run"]).stdout).toContain(`${major}.${minor}.${patch + 1}`);
    expect(bump(["minor", "--dry-run"]).stdout).toContain(`${major}.${minor + 1}.0`);
    expect(bump(["major", "--dry-run"]).stdout).toContain(`${major + 1}.0.0`);
  });

  it("is idempotent and wired to npm run version:bump", () => {
    expect(root.scripts?.["version:bump"]).toBe("node scripts/bump-version.mjs");
    const result = bump([`v${root.version}`, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to do");
  });

  it("refuses a missing or malformed target", () => {
    expect(bump(["--dry-run"]).stderr).toContain("missing version");
    expect(bump(["1.2", "--dry-run"]).stderr).toContain("is not a version");
    expect(bump(["1.2.3", "--nope"]).stderr).toContain("unknown flag");
  });
});
