/**
 * `argos validate` exit codes and diagnostics (Phase 8 verification): valid fixtures exit 0;
 * every invalid fixture exits 2 and prints the file and step the loader blamed.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ValidateReport } from "@thaodangspace/argos-core/rpc";

import { runCli } from "../src/main.js";
import { capture, withEnv } from "./support/cli.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const compatDir = join(root, "core", "test", "fixtures", "compat", ".paseo", "plugins", "playbooks");
const invalidDir = join(root, "core", "test", "fixtures", "invalid");
const invalidPlaybookDir = join(invalidDir, ".argos", "playbooks");
const precedenceDir = join(root, "core", "test", "fixtures", "precedence");
const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

/**
 * Commit a stable `--json` report as a golden file, exactly like `json-shapes.test.ts`:
 * `UPDATE_GOLDEN=1 npx vitest run --project cli`.
 */
function expectGolden(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(goldenDir, name);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  if (!existsSync(file)) throw new Error(`missing golden ${file}; run with UPDATE_GOLDEN=1`);
  expect(text).toBe(readFileSync(file, "utf8"));
}

const SIMPLE = (title: string): string => `title: ${title}\nsteps:\n  - id: a\n    prompt: Do A\n`;

const scratch: string[] = [];

/** A temp directory, removed after the test; any path is created on demand. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argos-validate-"));
  scratch.push(dir);
  return dir;
}

function writeFile(dir: string, relativePath: string, body: string): string {
  const file = join(dir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

describe("argos validate", () => {
  // Every command here reads the global library from the home; point it at an empty temp directory
  // so a developer's real `~/.argos/playbooks` can never change the report. The explicit-home test
  // below passes `--home` to select a library of its own.
  let restoreEnv: () => void;
  let emptyHome: string;

  beforeEach(() => {
    emptyHome = tempDir();
    restoreEnv = withEnv({ ARGOS_HOME: emptyHome });
  });

  afterEach(() => {
    restoreEnv();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 for the compat and precedence fixtures", async () => {
    for (const directory of [compatDir, precedenceDir]) {
      const captured = capture();
      const code = await runCli(["validate", directory], captured.io);
      expect(code, captured.stdout() + captured.stderr()).toBe(0);
      expect(captured.stdout()).toContain("valid");
    }
  });

  it("prints the file and step for every invalid fixture", async () => {
    const fixtures = readdirSync(invalidPlaybookDir)
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    for (const name of fixtures) {
      const captured = capture();
      const code = await runCli(["validate", join(invalidPlaybookDir, name)], captured.io);
      const output = captured.stdout() + captured.stderr();
      expect(code, `${name}: ${output}`).toBe(2);
      expect(output).toContain(name === "cycle.yaml" ? "playbook_cycle" : "playbook_invalid");
      expect(output).toMatch(/step [a-z]/);
      expect(output).toContain(".argos/playbooks/");
    }
  });

  it("reports every invalid playbook in a directory in one run", async () => {
    const captured = capture();
    const code = await runCli(["validate", invalidDir, "--json"], captured.io);
    expect(code).toBe(2);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(false);
    expect(report.playbooks).toEqual([]);
    expect(report.errors.length).toBeGreaterThanOrEqual(8);
    for (const error of report.errors) {
      expect(error.code).toMatch(/^playbook_/);
      expect(error.stepId).not.toBeNull();
      expect(error.file).toContain(".argos/playbooks/");
    }
  });

  it("validates a single file with its repository root inferred", async () => {
    const captured = capture();
    const code = await runCli(
      ["validate", join(compatDir, "pr.yaml"), "--json"],
      captured.io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(true);
    expect(report.playbooks).toEqual([
      { id: "pr", file: `.paseo/plugins/playbooks/${basename("pr.yaml")}`, hash: expect.any(String) },
    ]);
  });

  it("fails with exit 1 for a missing path", async () => {
    const captured = capture();
    const code = await runCli(["validate", "/definitely/not/here"], captured.io);
    expect(code).toBe(1);
    expect(captured.stderr()).toContain("path not found");
  });

  it("reports a playbook that exists only under the home, and --home selects that home", async () => {
    const repo = tempDir();
    const library = tempDir();
    const globalFile = writeFile(library, "playbooks/global.yaml", SIMPLE("Global"));

    const captured = capture();
    const code = await runCli(
      ["validate", repo, "--json", "--home", library],
      captured.io,
    );
    expect(code, captured.stdout() + captured.stderr()).toBe(0);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(true);
    // Outside the repository, so the report names the real absolute path.
    expect(report.playbooks).toStrictEqual([
      { id: "global", file: globalFile, hash: expect.any(String) },
    ]);

    // A different home has no library, so the same directory validates an empty set.
    const other = capture();
    const otherHome = tempDir();
    const otherCode = await runCli(
      ["validate", repo, "--json", "--home", otherHome],
      other.io,
    );
    expect(otherCode).toBe(0);
    expect((JSON.parse(other.stdout()) as ValidateReport).playbooks).toStrictEqual([]);
  });

  it("reads the global library from ARGOS_HOME when --home is omitted", async () => {
    const repo = tempDir();
    const library = tempDir();
    const globalFile = writeFile(library, "playbooks/env-global.yaml", SIMPLE("Env Global"));
    const restore = withEnv({ ARGOS_HOME: library });
    try {
      const captured = capture();
      const code = await runCli(["validate", repo, "--json"], captured.io);
      expect(code, captured.stdout() + captured.stderr()).toBe(0);
      const report = JSON.parse(captured.stdout()) as ValidateReport;
      expect(report.playbooks).toStrictEqual([
        { id: "env-global", file: globalFile, hash: expect.any(String) },
      ]);
    } finally {
      restore();
    }
  });

  it("fails the command for one invalid global file even when the repository is clean", async () => {
    const repo = tempDir();
    writeFile(repo, ".argos/playbooks/local.yaml", SIMPLE("Local"));
    const library = tempDir();
    const brokenFile = writeFile(
      library,
      "playbooks/broken.yaml",
      "title: Broken\nsteps:\n  - id: a\n    needs: [ghost]\n    prompt: A\n",
    );

    const captured = capture();
    const code = await runCli(["validate", repo, "--json", "--home", library], captured.io);
    expect(code).toBe(2);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(false);
    expect(report.playbooks.map((playbook) => playbook.id)).toStrictEqual(["local"]);
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    expect(report.errors[0]?.file).toBe(brokenFile);
  });

  it("resolves home siblings when an explicit home file is validated by path", async () => {
    const library = tempDir();
    writeFile(
      library,
      "playbooks/global-parent.yaml",
      [
        "title: Global Parent",
        "steps:",
        "  - id: block",
        "    use: global-child",
        "  - id: finish",
        "    prompt: Finish",
        "    needs: [block]",
        "    role: globaler",
        "",
      ].join("\n"),
    );
    writeFile(library, "playbooks/global-child.yaml", SIMPLE("Global Child"));
    writeFile(library, "roles/globaler/role.yaml", "title: Globaler\n");

    const captured = capture();
    const code = await runCli(
      [
        "validate",
        join(library, "playbooks", "global-parent.yaml"),
        "--json",
        "--home",
        library,
      ],
      captured.io,
    );
    expect(code, captured.stdout() + captured.stderr()).toBe(0);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(true);
    expect(report.playbooks.map((playbook) => playbook.id)).toStrictEqual(["global-parent"]);
  });

  /** A scratch repository with the given files, removed after the test. */
  function repo(files: Readonly<Record<string, string>>): string {
    const dir = tempDir();
    for (const [relativePath, body] of Object.entries(files)) writeFile(dir, relativePath, body);
    return dir;
  }

  const LEGACY = "title: Legacy\nsteps:\n  - id: work\n    prompt: Work\n    continue_on_error: true\n";
  const TYPOS = [
    "title: Typos",
    "steps:",
    "  - id: work",
    "    prompt: Work",
    "    typo_one: 1",
    "    typo_two: 1",
    "    typo_three: 1",
    "",
  ].join("\n");

  it("reports warnings in --json and exits 0 when there are only warnings", async () => {
    const dir = repo({ ".paseo/plugins/playbooks/legacy.yaml": LEGACY });
    const captured = capture();
    const code = await runCli(["validate", dir, "--json"], captured.io);

    expect(code, captured.stdout() + captured.stderr()).toBe(0);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(true);
    expect(report.errors).toStrictEqual([]);
    expect(report.warnings).toStrictEqual([
      {
        file: ".paseo/plugins/playbooks/legacy.yaml",
        stepId: "work",
        code: "unknown_key",
        message: 'unrecognized key "continue_on_error"',
      },
    ]);
  });

  it("prints warnings after errors in human output", async () => {
    const dir = repo({
      ".argos/playbooks/broken.yaml": "title: Broken\nsteps:\n  - id: work\n    prompt: Work\n    need: [prep]\n",
      ".paseo/plugins/playbooks/legacy.yaml": LEGACY,
    });
    const captured = capture();
    const code = await runCli(["validate", dir], captured.io);
    const output = captured.stdout();

    expect(code, output + captured.stderr()).toBe(2);
    expect(output).toContain("FAIL");
    expect(output).toContain("WARN");
    expect(output.indexOf("FAIL")).toBeLessThan(output.indexOf("WARN"));
    expect(output).toContain(".paseo/plugins/playbooks/legacy.yaml: step work: unknown_key");
  });

  it("writes one errors[] entry per schema issue", async () => {
    const dir = repo({ ".argos/playbooks/typos.yaml": TYPOS });
    const captured = capture();
    const code = await runCli(["validate", dir, "--json"], captured.io);

    expect(code).toBe(2);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.errors).toHaveLength(3);
    for (const error of report.errors) {
      expect(error.file).toBe(".argos/playbooks/typos.yaml");
      expect(error.stepId).toBe("work");
      expect(error.code).toBe("playbook_invalid");
    }
    expect(report.errors.map((error) => error.message).join("\n")).toContain("typo_two");
  });

  it("matches the committed --json golden", async () => {
    const dir = repo({
      ".argos/playbooks/broken.yaml":
        "title: Broken\nsteps:\n  - id: work\n    prompt: Work\n    need: [prep]\n",
      ".argos/playbooks/good.yaml": SIMPLE("Good"),
      ".argos/playbooks/legacy.yaml":
        "title: Legacy\nsteps:\n  - id: work\n    prompt: Work\n    poll_ms: 25\n",
      ".paseo/plugins/playbooks/unknown.yaml": LEGACY,
    });
    const captured = capture();
    const code = await runCli(["validate", dir, "--json"], captured.io);

    expect(code).toBe(2);
    expectGolden("validate.json", JSON.parse(captured.stdout()));
  });
});
