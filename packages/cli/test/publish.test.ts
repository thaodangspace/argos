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
const published = [core, cli];

describe("npm package manifests", () => {
  it("keeps the whole repo on one publishable version", () => {
    const version = root.version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toBe("0.0.0");
    for (const packageManifest of [core, cli, plugin]) {
      expect(packageManifest.version, packageManifest.name).toBe(version);
    }
  });

  it("publishes core and the CLI, and pins core to the shipped version", () => {
    expect(core.name).toBe("@thaodangspace/argos-core");
    expect(cli.name).toBe("@thaodangspace/argos");
    expect(cli.dependencies?.["@thaodangspace/argos-core"]).toBe(core.version);
    expect(plugin.dependencies?.["@thaodangspace/argos-core"]).toBe(core.version);
    expect(plugin.private).toBe(true);
  });

  it.each(published)("gives $name publishable metadata", (packageManifest) => {
    expect(packageManifest.private).toBeUndefined();
    expect(packageManifest.publishConfig?.access).toBe("public");
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.engines?.node).toBe(">=22.13");
    expect(packageManifest.files).toContain("dist");
    expect(packageManifest.repository?.url).toContain("github.com/thaodangspace/argos");
    expect(packageManifest.scripts?.["prepublishOnly"]).toBe("npm run build");
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

  it("has a tag-driven release workflow that publishes core before the CLI", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const corePublish = workflow.indexOf("npm publish -w @thaodangspace/argos-core");
    const cliPublish = workflow.indexOf("npm publish -w @thaodangspace/argos ");
    expect(corePublish).toBeGreaterThan(-1);
    expect(cliPublish).toBeGreaterThan(corePublish);
    expect(workflow).toContain("--provenance");
    expect(workflow).toContain("scripts/check-version.mjs");
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
