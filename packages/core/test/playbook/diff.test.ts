/**
 * `diffPlaybookIr` (S-FR4): the pure "what changed since this run froze its definition" answer.
 *
 * These tests pin the contract the fork guard depends on: a reformatted YAML is not a change, a
 * real definition edit names the steps it touched, and the playbook-level surfaces are exactly the
 * ones a fork cannot survive (`id`, `version`, `isolation`, `after`) plus input declarations.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { playbook, step } from "../../src/engine/test-util.js";
import { diffPlaybookIr, type IrDiff } from "../../src/playbook/diff.js";
import { loadPlaybook } from "../../src/playbook/index.js";
import type { PlaybookIR, StepIR } from "../../src/playbook/ir.js";

// ------------------------------------------------------------------ fixtures

const directories: string[] = [];

function makeRepo(files: Readonly<Record<string, string>>): string {
  const repo = mkdtempSync(join(tmpdir(), "argos-diff-"));
  directories.push(repo);
  const dir = join(repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  for (const [id, yaml] of Object.entries(files)) writeFileSync(join(dir, `${id}.yaml`), yaml);
  return repo;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const NO_DIFF: IrDiff = { stepOrder: false, playbook: [], inputs: [], steps: [] };

/** `a → b → c`, one input, no isolation block beyond the default. */
function base(): PlaybookIR {
  return playbook({
    id: "fork",
    inputs: { topic: { type: "string", required: true } },
    steps: [
      step({ id: "a", prompt: "Draft the plan." }),
      step({ id: "b", needs: ["a"], prompt: "Review the plan." }),
      step({ id: "c", needs: ["b"], prompt: "Publish the plan." }),
    ],
  });
}

function editStep(ir: PlaybookIR, id: string, patch: Partial<StepIR>): PlaybookIR {
  return { ...ir, steps: ir.steps.map((current) => (current.id === id ? { ...current, ...patch } : current)) };
}

const FIXTURE = `title: Fork fixture
inputs:
  topic:
    type: string
    required: true
steps:
  - id: a
    prompt: Draft the plan.
  - id: b
    needs: [a]
    prompt: Review the plan.
`;

describe("diffPlaybookIr (S-FR4)", () => {
  it("reports nothing for the same definition, by identity or by value", () => {
    const ir = base();
    expect(diffPlaybookIr(ir, ir)).toEqual(NO_DIFF);
    expect(diffPlaybookIr(ir, structuredClone(ir) as PlaybookIR)).toEqual(NO_DIFF);
  });

  it("reports nothing when the same file is loaded twice, or reformatted", () => {
    const repo = makeRepo({ fixture: FIXTURE });
    const first = loadPlaybook(repo, "fixture");
    expect(diffPlaybookIr(first, loadPlaybook(repo, "fixture"))).toEqual(NO_DIFF);

    // Same document, different formatting: quoting, indentation, key order. The IR is identical,
    // so an operator running a formatter must not be refused a fork.
    writeFileSync(
      join(repo, ".argos", "playbooks", "fixture.yaml"),
      `title: 'Fork fixture'
steps:
    - prompt: "Draft the plan."
      id: a
    - prompt: 'Review the plan.'
      needs:
        - a
      id: b
inputs:
    topic:
        required: true
        type: string
`,
    );
    expect(diffPlaybookIr(first, loadPlaybook(repo, "fixture"))).toEqual(NO_DIFF);
  });

  it("names only the step whose prompt changed", () => {
    const diff = diffPlaybookIr(base(), editStep(base(), "b", { prompt: "Review harder." }));
    expect(diff).toEqual({ stepOrder: false, playbook: [], inputs: [], steps: ["b"] });
  });

  it("treats agent, timing, script, output, and routing edits as step changes", () => {
    const patches: readonly Partial<StepIR>[] = [
      { agent: { provider: "anthropic", model: "opus", labels: {} } },
      { timeout: "10m" },
      { retries: 3 },
      { pollMs: 500 },
      { labels: { "argos/tier": "slow" } },
      { script: { run: "review.sh", env: ["PATH"] } },
      { outputs: { summary: { type: "string" } } },
      { on: { success: { kind: "complete" } } },
      { when: { "steps.a.outcome": "failure" } },
    ];
    for (const patch of patches) {
      const diff = diffPlaybookIr(base(), editStep(base(), "b", patch));
      expect(diff.steps, JSON.stringify(patch)).toEqual(["b"]);
      expect(diff.stepOrder).toBe(false);
      expect(diff.playbook).toEqual([]);
      expect(diff.inputs).toEqual([]);
    }
  });

  it("reports the steps in the frozen definition's order", () => {
    const edited = editStep(editStep(base(), "a", { prompt: "x" }), "b", { prompt: "y" });
    expect(diffPlaybookIr(base(), edited).steps).toEqual(["a", "b"]);
  });

  it("reports an added, removed, or reordered step as a different shape", () => {
    const added = { ...base(), steps: [...base().steps, step({ id: "d", needs: ["c"] })] };
    const removed = { ...base(), steps: base().steps.slice(0, 2) };
    const reordered = { ...base(), steps: [base().steps[1] as StepIR, base().steps[0] as StepIR, base().steps[2] as StepIR] };

    for (const edited of [added, removed, reordered]) {
      const diff = diffPlaybookIr(base(), edited);
      expect(diff.stepOrder).toBe(true);
      // A different shape makes the per-step answer meaningless; the guard refuses on `stepOrder`.
      expect(diff.steps).toEqual([]);
    }
  });

  it("reports changed, added, and removed input declarations by name", () => {
    const changed: PlaybookIR = {
      ...base(),
      inputs: { topic: { type: "string", required: false } },
    };
    expect(diffPlaybookIr(base(), changed).inputs).toEqual(["topic"]);

    const added = { ...base(), inputs: { ...base().inputs, extra: { type: "number" as const } } };
    expect(diffPlaybookIr(base(), added).inputs).toEqual(["extra"]);

    const removed = { ...base(), inputs: {} };
    expect(diffPlaybookIr(base(), removed).inputs).toEqual(["topic"]);

    const retyped: PlaybookIR = {
      ...base(),
      inputs: { topic: { type: "enum", values: ["a", "b"] } },
    };
    expect(diffPlaybookIr(base(), retyped).inputs).toEqual(["topic"]);
  });

  it("ignores an input description edit", () => {
    const described: PlaybookIR = {
      ...base(),
      inputs: { topic: { type: "string", required: true, description: "What to plan." } },
    };
    expect(diffPlaybookIr(base(), described)).toEqual(NO_DIFF);
  });

  it("reports isolation and after changes, but not an absent-versus-none isolation", () => {
    const explicitNone = { ...base(), isolation: { mode: "none" as const } };
    const { isolation: _dropped, ...withoutIsolation } = base();
    const absent: PlaybookIR = withoutIsolation;
    expect(diffPlaybookIr(explicitNone, absent).playbook).toEqual([]);

    const isolated = { ...base(), isolation: { mode: "worktree" as const } };
    expect(diffPlaybookIr(base(), isolated).playbook).toEqual(["isolation"]);

    const withAfter = {
      ...base(),
      after: [
        {
          id: "report",
          title: "Report",
          trigger: "auto" as const,
          steps: [step({ id: "report-1" })],
        },
      ],
    };
    expect(diffPlaybookIr(base(), withAfter).playbook).toEqual(["after"]);
  });

  it("reports id and version mismatches", () => {
    expect(diffPlaybookIr(base(), { ...base(), id: "other" }).playbook).toEqual(["id"]);
    expect(diffPlaybookIr(base(), { ...base(), version: 2 as unknown as 1 }).playbook).toEqual([
      "version",
    ]);
  });

  it("ignores the playbook-level surfaces a fork cannot observe", () => {
    const cosmetic: PlaybookIR = {
      ...base(),
      title: "Renamed",
      description: "A new description.",
      hash: "a-different-hash",
      concurrency: 4,
      outcomes: ["shipped"],
      defaults: { labels: { team: "core" } },
      providers: { onExhausted: "wait", maxWaitMs: 60_000 },
      roles: {
        reviewer: {
          id: "reviewer",
          title: "Reviewer",
          readonly: true,
          instructions: "Review carefully.",
          fallbacks: [],
        },
      },
      blocks: {
        inner: {
          id: "inner",
          playbookId: "inner",
          title: "Inner",
          stepIds: [],
          entry: [],
          terminals: [],
          inputs: {},
          outputs: {},
          outcomes: [],
          on: {},
        },
      },
    };
    expect(diffPlaybookIr(base(), cosmetic)).toEqual(NO_DIFF);
  });

  it("reports a playbook label edit as a step change, because labels merge into every step", () => {
    // `resolve.ts` merges playbook labels into every `StepIR.labels`, so a label edit is a real
    // dispatch change for the whole graph — unlike a title or description edit.
    const repo = makeRepo({
      plain: `title: L\nsteps:\n  - id: a\n    prompt: p\n  - id: b\n    needs: [a]\n    prompt: q\n`,
      labelled: `title: L\nlabels:\n  team: core\nsteps:\n  - id: a\n    prompt: p\n  - id: b\n    needs: [a]\n    prompt: q\n`,
    });
    const diff = diffPlaybookIr(loadPlaybook(repo, "plain"), loadPlaybook(repo, "labelled"));
    expect(diff.steps).toEqual(["a", "b"]);
    expect(diff.playbook).toEqual(["id"]); // only the filename-derived id differs
  });
});
