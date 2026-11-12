/**
 * FR4.1: the shared resolve half of a start.
 *
 * `resolveRunRequest` is what `POST /runs` and a schedule fire both call before any task exists, so
 * these tests cover the contract every caller relies on: `cwd` first, then the loader, then the
 * input coercion/defaults, with the same codes and messages the HTTP route answers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRunRequest } from "../../src/durable/run-request.js";
import { isArgosError } from "../../src/errors.js";

// ------------------------------------------------------------------ fixtures

const directories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `argos-${prefix}-`));
  directories.push(directory);
  return directory;
}

/** A repository directory holding `.argos/playbooks/<id>.yaml`. */
function makeRepo(playbooks: Readonly<Record<string, string>>): string {
  const repo = makeDirectory("run-request");
  const dir = join(repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  for (const [id, yaml] of Object.entries(playbooks)) {
    writeFileSync(join(dir, `${id}.yaml`), yaml, "utf8");
  }
  return repo;
}

/** A `$ARGOS_HOME` holding `<home>/playbooks/<id>.yaml`. */
function makeHome(playbooks: Readonly<Record<string, string>>): string {
  const home = makeDirectory("run-request-home");
  const dir = join(home, "playbooks");
  mkdirSync(dir, { recursive: true });
  for (const [id, yaml] of Object.entries(playbooks)) {
    writeFileSync(join(dir, `${id}.yaml`), yaml, "utf8");
  }
  return home;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const TYPED_PLAYBOOK = `title: Typed inputs
inputs:
  count:
    type: number
    required: true
  flag:
    type: boolean
  mode:
    type: enum
    values:
      - fast
      - slow
  label:
    type: string
    default: hello
steps:
  - id: a
    prompt: Do the work.
`;

const PLAIN_PLAYBOOK = `title: Plain
steps:
  - id: a
    prompt: Do the work.
`;

function codeOf(error: unknown): string {
  return isArgosError(error) ? error.code : `<not an ArgosError: ${String(error)}>`;
}

/** Run a synchronous `resolveRunRequest` and return the thrown error (or throw the test's own). */
function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ tests

describe("resolveRunRequest (FR4.1)", () => {
  it("coerces number, boolean, enum, and string inputs", () => {
    const repo = makeRepo({ typed: TYPED_PLAYBOOK });
    const resolved = resolveRunRequest({
      playbookId: "typed",
      cwd: repo,
      inputs: { count: "42", flag: "true", mode: "slow", label: 7 },
    });
    expect(resolved.ir.id).toBe("typed");
    expect(resolved.cwd).toBe(repo);
    expect(resolved.inputs).toEqual({
      count: 42,
      flag: true,
      mode: "slow",
      label: "7",
    });
  });

  it("accepts the scalar spellings a CLI or JSON body can produce", () => {
    const repo = makeRepo({ typed: TYPED_PLAYBOOK });
    const resolved = resolveRunRequest({
      playbookId: "typed",
      cwd: repo,
      inputs: { count: 3, flag: "0", mode: "fast", label: false },
    });
    expect(resolved.inputs["count"]).toBe(3);
    expect(resolved.inputs["flag"]).toBe(false);
    expect(resolved.inputs["mode"]).toBe("fast");
    expect(resolved.inputs["label"]).toBe("false");
  });

  it("fills declared defaults and refuses a missing required input", () => {
    const repo = makeRepo({ typed: TYPED_PLAYBOOK });
    const filled = resolveRunRequest({ playbookId: "typed", cwd: repo, inputs: { count: 1 } });
    expect(filled.inputs["label"]).toBe("hello");
    // An omitted optional input stays absent rather than becoming null/undefined.
    expect("flag" in filled.inputs).toBe(false);

    const missing = errorOf(() => resolveRunRequest({ playbookId: "typed", cwd: repo }));
    expect(codeOf(missing)).toBe("invalid_request");
    expect(messageOf(missing)).toContain('missing required input "count"');
  });

  it("refuses a bad input value with invalid_request", () => {
    const repo = makeRepo({ typed: TYPED_PLAYBOOK });
    const cases: ReadonlyArray<readonly [string, Record<string, string | number | boolean>]> = [
      ["number", { count: "not-a-number" }],
      ["boolean", { count: 1, flag: "perhaps" }],
      ["enum", { count: 1, mode: "sideways" }],
    ];
    for (const [label, inputs] of cases) {
      const error = errorOf(() => resolveRunRequest({ playbookId: "typed", cwd: repo, inputs }));
      expect(codeOf(error), label).toBe("invalid_request");
      expect(messageOf(error), label).toContain('input "');
    }
  });

  it("refuses a relative, NUL-bearing, missing, or file cwd before the loader runs", async () => {
    // The repository exists and holds the playbook, so a bad cwd can only be refused by the cwd
    // check itself: if the loader ran first, a relative path would resolve and the missing/file
    // cases would answer `playbook_missing` instead.
    const repo = makeRepo({ plain: PLAIN_PLAYBOOK });
    const file = join(repo, "notes.txt");
    writeFileSync(file, "not a directory\n", "utf8");

    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["relative/repo", "relative path", "is not an absolute path"],
      [`${repo}\u0000suffix`, "NUL byte", "NUL byte"],
      [join(repo, "missing"), "missing path", "does not exist"],
      [file, "file", "is not a directory"],
    ];
    for (const [cwd, label, fragment] of cases) {
      const error = errorOf(() => resolveRunRequest({ playbookId: "plain", cwd }));
      expect(codeOf(error), label).toBe("invalid_request");
      expect(messageOf(error), label).toContain(fragment);
      expect(messageOf(error), label).not.toContain("playbook plain");
    }
  });

  it("answers playbook_missing for an unknown playbook", () => {
    const repo = makeRepo({ plain: PLAIN_PLAYBOOK });
    const error = errorOf(() => resolveRunRequest({ playbookId: "absent", cwd: repo }));
    expect(codeOf(error)).toBe("playbook_missing");
    expect(messageOf(error)).toContain("absent");
  });

  it("resolves a playbook from the host home", () => {
    // The repository has no playbooks at all; only `<home>/playbooks` can satisfy the id.
    const repo = makeRepo({});
    const home = makeHome({ global: PLAIN_PLAYBOOK });
    const fromHome = resolveRunRequest({ playbookId: "global", cwd: repo, home });
    expect(fromHome.ir.id).toBe("global");
    expect(fromHome.cwd).toBe(repo);

    // Without the home the same request is refused: discovery stays repo-only.
    const error = errorOf(() => resolveRunRequest({ playbookId: "global", cwd: repo }));
    expect(codeOf(error)).toBe("playbook_missing");
  });

  it("resolves the repository copy before a home copy of the same id", () => {
    const repoYaml = PLAIN_PLAYBOOK.replace("title: Plain", "title: Repo copy");
    const repo = makeRepo({ shared: repoYaml });
    const home = makeHome({ shared: PLAIN_PLAYBOOK.replace("title: Plain", "title: Home copy") });
    const resolved = resolveRunRequest({ playbookId: "shared", cwd: repo, home });
    expect(resolved.ir.title).toBe("Repo copy");
  });
});
