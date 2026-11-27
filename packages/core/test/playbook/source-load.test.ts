/**
 * FR7: `LoadOptions.source` validates a buffer as if it were the bytes of `source.file`.
 *
 * Parity is the whole contract. The IR, its hash, the errors, the issues, and the warnings a
 * `source` load produces are the ones the identical bytes written to that path produce, while the
 * path identity — `.argos` vs `.paseo`, the role family, the unknown-key rule — still comes from
 * the path, which is why a temp file cannot stand in for it.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isArgosError, type ArgosError } from "../../src/errors.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { discoverPlaybooks, loadPlaybook, type LoadWarning } from "../../src/playbook/load.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const SIMPLE = (title: string): string => `title: ${title}\nsteps:\n  - id: a\n    prompt: Do A\n`;

/** A scratch repository; every directory is removed in `afterEach`. */
const directories: string[] = [];

interface TempRepo {
  readonly root: string;
  write(relativePath: string, body: string): string;
}

function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "argos-source-"));
  directories.push(root);
  return {
    root,
    write(relativePath: string, body: string): string {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

type Outcome =
  | { readonly ok: true; readonly ir: PlaybookIR }
  | { readonly ok: false; readonly error: ArgosError };

function attempt(run: () => PlaybookIR): Outcome {
  try {
    return { ok: true, ir: run() };
  } catch (error) {
    if (!isArgosError(error)) throw error;
    return { ok: false, error };
  }
}

/** Load one fixture twice: from the bytes on disk, and from those same bytes as a `source`. */
function bothWays(repo: string, id: string, file: string, warnings?: LoadWarning[]): {
  readonly disk: Outcome;
  readonly buffer: Outcome;
} {
  const text = readFileSync(file, "utf8");
  const disk = attempt(() =>
    warnings === undefined
      ? loadPlaybook(repo, id)
      : loadPlaybook(repo, id, { warnings }),
  );
  const buffer = attempt(() =>
    warnings === undefined
      ? loadPlaybook(repo, id, { source: { file, text } })
      : loadPlaybook(repo, id, { source: { file, text }, warnings }),
  );
  return { disk, buffer };
}

function expectSameOutcome(disk: Outcome, buffer: Outcome): void {
  expect(buffer.ok).toBe(disk.ok);
  if (disk.ok && buffer.ok) {
    expect(buffer.ir).toStrictEqual(disk.ir);
    expect(buffer.ir.hash).toBe(disk.ir.hash);
    return;
  }
  if (!disk.ok && !buffer.ok) {
    expect(buffer.error.code).toBe(disk.error.code);
    expect(buffer.error.stepId).toBe(disk.error.stepId);
    expect(buffer.error.file).toBe(disk.error.file);
    expect(buffer.error.issues).toStrictEqual(disk.error.issues);
    return;
  }
}

// ---------------------------------------------------------------- (a) parity

const PARITY_FIXTURES = ["compat", "aliases", "subplaybook", "when"] as const;

const PARITY = PARITY_FIXTURES.flatMap((name) => {
  const repo = join(FIXTURES, name);
  return discoverPlaybooks(repo).map((entry) => ({ label: `${name}/${entry.id}`, repo, entry }));
});

describe("a buffer load is the load of the same bytes on disk (FR7)", () => {
  it("covers every fixture playbook, valid and invalid", () => {
    expect(PARITY.length).toBeGreaterThan(10);
    const outcomes = PARITY.map(({ repo, entry }) => attempt(() => loadPlaybook(repo, entry.id)));
    expect(outcomes.some((outcome) => outcome.ok)).toBe(true);
    expect(outcomes.some((outcome) => !outcome.ok)).toBe(true);
  });

  it.each(PARITY)("$label", ({ repo, entry }) => {
    const { disk, buffer } = bothWays(repo, entry.id, entry.file);
    expectSameOutcome(disk, buffer);
    if (disk.ok) expect(disk.ir.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// -------------------------------------------------------------- (b) text wins

describe("the buffer text wins over the bytes on disk", () => {
  it("locks the IR and the hash to the text, not the file", () => {
    const repo = tempRepo();
    const file = repo.write(".argos/playbooks/edit.yaml", SIMPLE("On disk"));
    const buffer = SIMPLE("From buffer");

    const disk = loadPlaybook(repo.root, "edit");
    const source = loadPlaybook(repo.root, "edit", { source: { file, text: buffer } });

    expect(disk.title).toBe("On disk");
    expect(source.title).toBe("From buffer");
    expect(source.hash).not.toBe(disk.hash);
    // The load is read-only: nothing was written, so the next disk load is unchanged.
    expect(readFileSync(file, "utf8")).toBe(SIMPLE("On disk"));
    expect(loadPlaybook(repo.root, "edit").title).toBe("On disk");
  });

  it("matches the same file reached by a realpath spelling of the path", () => {
    // On macOS `mkdtemp` sits under the `/tmp` symlink, so the entry path and its realpath differ.
    const repo = tempRepo();
    const file = repo.write(".argos/playbooks/edit.yaml", SIMPLE("On disk"));

    const source = loadPlaybook(repo.root, "edit", {
      source: { file: realpathSync(file), text: SIMPLE("From buffer") },
    });

    expect(source.title).toBe("From buffer");
  });

  it("still resolves defaults and roles from disk, never from the buffer", () => {
    const repo = tempRepo();
    const file = repo.write(
      ".argos/playbooks/styled.yaml",
      "title: On disk\nsteps:\n  - id: a\n    prompt: Do A\n    role: helper\n",
    );
    repo.write(".argos/defaults/main.yaml", "agent:\n  provider: disk-provider\n  model: disk-model\n");
    repo.write(".argos/roles/helper/role.yaml", "title: Disk Helper\n");
    repo.write(".argos/roles/helper/instructions.md", "Disk instructions.");

    const ir = loadPlaybook(repo.root, "styled", {
      source: {
        file,
        text: "title: From buffer\nsteps:\n  - id: a\n    prompt: Do A\n    role: helper\n",
      },
    });

    expect(ir.title).toBe("From buffer");
    expect(ir.steps[0]?.agent).toMatchObject({ provider: "disk-provider", model: "disk-model" });
    expect(ir.roles["helper"]?.instructions).toBe("Disk instructions.");
  });
});

// ------------------------------------------------------- (c) error parity

describe("an invalid buffer fails exactly like the same bytes on disk", () => {
  const INVALID = join(FIXTURES, "invalid");
  const CASES = discoverPlaybooks(INVALID).map((entry) => ({
    label: entry.id,
    file: entry.file,
  }));

  it.each(CASES)("$label keeps the code, step id, and issues", ({ label, file }) => {
    const { disk, buffer } = bothWays(INVALID, label, file);
    expect(disk.ok).toBe(false);
    expectSameOutcome(disk, buffer);
  });

  it("carries the same issue list through both paths", () => {
    const repo = tempRepo();
    const body = [
      "title: Typo",
      "steps:",
      "  - id: work",
      "    prompt: Work",
      '    modle: "opus"',
      "",
    ].join("\n");
    const file = repo.write(".argos/playbooks/typo.yaml", body);

    const { disk, buffer } = bothWays(repo.root, "typo", file);

    expect(disk.ok).toBe(false);
    expectSameOutcome(disk, buffer);
    if (buffer.ok) return;
    expect(buffer.error.code).toBe("playbook_invalid");
    expect(buffer.error.stepId).toBe("work");
    expect(buffer.error.issues).toStrictEqual([
      { path: "steps.0.modle", stepId: "work", message: 'unrecognized key "modle"' },
    ]);
  });
});

// ------------------------------------------------------- (d) `.paseo` origin

describe("the unknown-key rule follows source.file, not the buffer", () => {
  const BODY = ["title: Loose", "bogus: 1", "other: 2", "steps:", "  - id: a", "    prompt: Do A", ""].join(
    "\n",
  );

  it("warns once per unknown key in a .paseo file through a buffer load", () => {
    const repo = tempRepo();
    const paseoFile = repo.write(".paseo/plugins/playbooks/loose.yaml", BODY);
    const argosFile = repo.write(".argos/playbooks/strict.yaml", BODY);

    const bufferWarnings: LoadWarning[] = [];
    const buffer = loadPlaybook(repo.root, "loose", {
      source: { file: paseoFile, text: BODY },
      warnings: bufferWarnings,
    });
    const diskWarnings: LoadWarning[] = [];
    const disk = loadPlaybook(repo.root, "loose", { warnings: diskWarnings });

    expect(bufferWarnings).toStrictEqual(diskWarnings);
    expect(bufferWarnings.map((warning) => warning.code)).toStrictEqual(["unknown_key", "unknown_key"]);
    expect(bufferWarnings.map((warning) => warning.file)).toStrictEqual([paseoFile, paseoFile]);
    expect(bufferWarnings.map((warning) => warning.stepId)).toStrictEqual([null, null]);
    expect(bufferWarnings.map((warning) => warning.message)).toStrictEqual([
      'unrecognized key "bogus"',
      'unrecognized key "other"',
    ]);
    expect(buffer.hash).toBe(disk.hash);

    // The same bytes under `.argos/` are a hard failure, through the buffer path too.
    const { disk: strictOnDisk, buffer: strictBuffer } = bothWays(repo.root, "strict", argosFile);
    expect(strictOnDisk.ok).toBe(false);
    expectSameOutcome(strictOnDisk, strictBuffer);
    if (strictBuffer.ok) return;
    expect(strictBuffer.error.code).toBe("playbook_invalid");
    expect(strictBuffer.error.issues?.map((issue) => issue.path)).toStrictEqual([
      "bogus",
      "other",
    ]);
  });
});

// --------------------------------------------------------- (e) role family

describe("a sub-playbook keeps resolving from the repository root through a buffer load", () => {
  it("expands and resolves roles identically", () => {
    const repo = tempRepo();
    const parentFile = repo.write(
      ".argos/playbooks/parent.yaml",
      [
        "title: Parent",
        "steps:",
        "  - id: block",
        "    use: child",
        "  - id: finish",
        "    prompt: Finish",
        "    needs: [block]",
        "    role: helper",
        "",
      ].join("\n"),
    );
    repo.write(".argos/playbooks/child.yaml", SIMPLE("Child"));
    repo.write(".argos/roles/helper/role.yaml", "title: Helper\n");
    repo.write(".argos/roles/helper/instructions.md", "Helper instructions.");

    const { disk, buffer } = bothWays(repo.root, "parent", parentFile);

    expect(disk.ok).toBe(true);
    expectSameOutcome(disk, buffer);
    if (!buffer.ok) return;
    expect(buffer.ir.steps.map((step) => step.id)).toStrictEqual(["block.a", "finish"]);
    expect(buffer.ir.steps[0]?.use).toStrictEqual({ blockId: "block", playbookId: "child", depth: 1 });
    expect(buffer.ir.steps[1]?.role?.instructions).toBe("Helper instructions.");
    expect(buffer.ir.roles["helper"]?.title).toBe("Helper");
  });
});

// ------------------------------------- (f) a path that exists only as a buffer

describe("a buffer load of a file that is not on disk", () => {
  /** A file the loader is told about but that was never written. */
  function ghostPath(repo: TempRepo): string {
    return join(repo.root, ".argos/playbooks/ghost.yaml");
  }

  it("loads the buffer instead of failing playbook_missing", () => {
    const repo = tempRepo();
    const ghost = ghostPath(repo);

    const ir = loadPlaybook(repo.root, "ghost", {
      file: ghost,
      source: { file: ghost, text: SIMPLE("Ghost") },
    });

    expect(ir.title).toBe("Ghost");
    // Without the buffer the very same path is an unreadable file.
    const withoutBuffer = attempt(() => loadPlaybook(repo.root, "ghost", { file: ghost }));
    expect(withoutBuffer.ok).toBe(false);
    if (!withoutBuffer.ok) expect(withoutBuffer.error.code).toBe("playbook_missing");
  });

  it("names source.file in every error it raises", () => {
    const repo = tempRepo();
    const ghost = ghostPath(repo);

    const cases = [
      {
        name: "invalid YAML",
        text: "title: [unclosed\n",
        code: "playbook_invalid",
        stepId: undefined,
      },
      {
        name: "unknown key",
        text: "title: Ghost\nbogus: 1\nsteps:\n  - id: a\n    prompt: Do A\n",
        code: "playbook_invalid",
        stepId: undefined,
      },
      {
        name: "unknown role",
        text: "title: Ghost\nsteps:\n  - id: work\n    prompt: Work\n    role: absent\n",
        code: "playbook_invalid",
        stepId: "work",
      },
      {
        name: "missing sub-playbook",
        text: "title: Ghost\nsteps:\n  - id: block\n    use: absent\n",
        code: "playbook_missing",
        stepId: "block",
      },
    ] as const;

    for (const testCase of cases) {
      const outcome = attempt(() =>
        loadPlaybook(repo.root, "ghost", { file: ghost, source: { file: ghost, text: testCase.text } }),
      );
      expect(outcome.ok, testCase.name).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.code, testCase.name).toBe(testCase.code);
      expect(outcome.error.stepId, testCase.name).toBe(testCase.stepId);
      expect(outcome.error.file, testCase.name).toBe(ghost);
      expect(outcome.error.message.startsWith(ghost), testCase.name).toBe(true);
    }
  });
});
