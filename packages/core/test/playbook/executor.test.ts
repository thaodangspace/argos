/**
 * FR4: the playbook-level `executor` key — schema, precedence, IR, hash, and refusal shape.
 *
 * Two halves make the contract. A playbook that names a substrate stores the canonical id in
 * `PlaybookIR.executor` (and mirrors it in `defaults.executor`, exactly like `isolation`) and
 * therefore has a different hash. A playbook that names no executor — or names `paseo`, the
 * default — keeps every IR byte and hash it had before this key existed, which is what keeps the
 * golden fixtures and every frozen run record valid. An unknown value is a load failure naming the
 * file, never a warning and never a step id.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isArgosError, type ArgosError } from "../../src/errors.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { loadPlaybook, type LoadWarning } from "../../src/playbook/index.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const EXECUTOR_FIXTURES = join(FIXTURES, "executor");
const COMPAT = join(FIXTURES, "compat");

// ------------------------------------------------------------------ fixtures

const directories: string[] = [];

/** A scratch repository root; every file is written from its repository-relative path. */
function makeRepo(files: Readonly<Record<string, string>>): string {
  const repo = mkdtempSync(join(tmpdir(), "argos-executor-"));
  directories.push(repo);
  for (const [relativePath, body] of Object.entries(files)) {
    const file = join(repo, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return repo;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** A one-step playbook whose only variable is the fragment under test. */
const playbookYaml = (head = ""): string =>
  `${head}title: Pinned substrate\nsteps:\n  - id: work\n    prompt: Do the work.\n`;

/** Load one of the flat `fixtures/executor/*.yaml` files by explicit path. */
function loadExecutorFixture(id: string): PlaybookIR {
  return loadPlaybook(EXECUTOR_FIXTURES, id, { file: join(EXECUTOR_FIXTURES, `${id}.yaml`) });
}

/** Load and return the failure, so each test can assert on code, file, and issues. */
function failure(run: () => unknown): ArgosError {
  try {
    run();
  } catch (error) {
    if (isArgosError(error)) return error;
    throw error;
  }
  throw new Error("the load was expected to fail");
}

// ------------------------------------------------------------------ IR and hash

describe("executor in the IR (FR4)", () => {
  it("stores a declared executor and its default in the IR", () => {
    const ir = loadExecutorFixture("_with-executor");
    expect(ir.executor).toBe("hc");
    // The defaults block mirrors the resolved value, exactly like `isolation`.
    expect(ir.defaults?.executor).toBe("hc");
    // A plain JSON round-trip keeps it (the IR is the frozen contract).
    expect(JSON.parse(JSON.stringify(ir))).toStrictEqual(ir);
  });

  it("moves the hash only when a non-default executor is declared", () => {
    // One file, rewritten in place: the id (and every other field) must not be part of the answer.
    const repo = makeRepo({ ".argos/playbooks/pinned.yaml": playbookYaml() });
    const file = join(repo, ".argos/playbooks/pinned.yaml");
    const plain = loadPlaybook(repo, "pinned");

    writeFileSync(file, playbookYaml("executor: paseo\n"));
    const explicitDefault = loadPlaybook(repo, "pinned");
    // `paseo` is what "absent" means, so naming it must not move a single byte.
    expect(explicitDefault.hash).toBe(plain.hash);
    expect(JSON.stringify(explicitDefault)).toBe(JSON.stringify(plain));

    writeFileSync(file, playbookYaml("executor: hc\n"));
    const pinned = loadPlaybook(repo, "pinned");
    expect(pinned.executor).toBe("hc");
    expect(pinned.hash).not.toBe(plain.hash);
  });

  it("keeps every existing playbook free of the key", () => {
    // The golden compat fixtures are the byte-stability proof: an untouched loader adds nothing.
    for (const id of ["pr", "docs"]) {
      const ir = loadPlaybook(COMPAT, id);
      expect(Object.hasOwn(ir, "executor"), id).toBe(false);
      expect(Object.hasOwn(ir.defaults ?? {}, "executor"), id).toBe(false);
    }
  });

  it("normalizes every alias to the canonical id", () => {
    for (const spelling of ["hc", "herdr", "herdr-core", "  Herdr-Core ", "HC"]) {
      const repo = makeRepo({ ".argos/playbooks/alias.yaml": playbookYaml(`executor: "${spelling}"\n`) });
      expect(loadPlaybook(repo, "alias").executor, spelling).toBe("hc");
    }
  });
});

// ------------------------------------------------------------------ precedence

describe("executor precedence (FR4)", () => {
  const DEFAULTS = "executor: herdr-core\n";

  it("honours the repository defaults/main.yaml when nothing else names an executor", () => {
    const repo = makeRepo({
      ".argos/defaults/main.yaml": DEFAULTS,
      ".argos/playbooks/from-repo-defaults.yaml": playbookYaml(),
    });
    const ir = loadPlaybook(repo, "from-repo-defaults");
    expect(ir.executor).toBe("hc");
    expect(ir.defaults?.executor).toBe("hc");
  });

  it("lets the playbook's defaults block beat the repository defaults", () => {
    const repo = makeRepo({
      ".argos/defaults/main.yaml": DEFAULTS,
      ".argos/playbooks/paseo-default.yaml": playbookYaml("defaults:\n  executor: paseo\n"),
    });
    const ir = loadPlaybook(repo, "paseo-default");
    expect(ir.executor).toBeUndefined();
    expect(Object.hasOwn(ir, "executor")).toBe(false);
    // The defaults block exists only because the playbook named a provider; the executor key is
    // simply absent from it.
    expect(Object.hasOwn(ir.defaults ?? {}, "executor")).toBe(false);
  });

  it("lets the top-level executor beat the playbook's defaults block", () => {
    const repo = makeRepo({
      ".argos/playbooks/top-wins.yaml": playbookYaml("executor: paseo\ndefaults:\n  executor: hc\n"),
      ".argos/playbooks/defaults-wins.yaml": playbookYaml("defaults:\n  executor: hc\n"),
    });
    // Top-level wins, and it resolves to the default substrate, so the IR stays clean.
    const topWins = loadPlaybook(repo, "top-wins");
    expect(topWins.executor).toBeUndefined();
    expect(Object.hasOwn(topWins, "executor")).toBe(false);
    expect(Object.hasOwn(topWins.defaults ?? {}, "executor")).toBe(false);

    const defaultsWins = loadPlaybook(repo, "defaults-wins");
    expect(defaultsWins.executor).toBe("hc");
    expect(defaultsWins.defaults?.executor).toBe("hc");
  });
});

// ------------------------------------------------------------------ refusals

describe("executor refusals (FR4)", () => {
  it("rejects an unknown value as playbook_invalid naming the file, not a step", () => {
    const file = join(EXECUTOR_FIXTURES, "_invalid.yaml");
    const error = failure(() => loadPlaybook(EXECUTOR_FIXTURES, "_invalid", { file }));

    // The loader speaks `playbook_invalid`; `invalid_request` is the RPC/CLI gate's code (FR3).
    expect(error.code).toBe("playbook_invalid");
    expect(error.file).toBe(file);
    expect(error.stepId).toBeUndefined();
    expect(error.message.startsWith(file)).toBe(true);
    expect(error.message).toContain("nope");

    expect(error.issues).toHaveLength(1);
    const issue = error.issues?.[0];
    expect(issue?.stepId).toBeUndefined();
    // The issue names the document position: the file plus the key, never a step path.
    expect(issue?.path).toBe(`${file}: executor`);
    expect(issue?.message).toContain("hc, paseo");
  });

  it("rejects an unknown value in a defaults layer too", () => {
    const repo = makeRepo({
      ".argos/defaults/main.yaml": "executor: nope\n",
      ".argos/playbooks/silent.yaml": playbookYaml(),
    });
    const error = failure(() => loadPlaybook(repo, "silent"));
    expect(error.code).toBe("playbook_invalid");
    expect(error.issues?.[0]?.path).toContain("executor");
  });

  it("never downgrades an unknown value to a warning", () => {
    // A `.paseo/` file may only *warn* about unknown keys; a bad value is not an unknown key.
    const repo = makeRepo({
      ".paseo/plugins/playbooks/legacy.yaml": playbookYaml("executor: nope\n"),
    });
    const warnings: LoadWarning[] = [];
    expect(() => loadPlaybook(repo, "legacy", { warnings })).toThrowError();
    expect(warnings).toStrictEqual([]);
  });
});
