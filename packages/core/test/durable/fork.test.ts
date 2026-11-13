/**
 * `argos fork` at host level (S-FR1–FR12).
 *
 * The contract these tests pin: a fork is a **new run** whose document contains exactly the
 * definition it runs, which inherits the parent's settled prefix, records the discontinuity in
 * `forkedFrom`, and refuses with `definition_conflict` when the edited definition escapes the set
 * the fork is about to re-run. The parent is evidence, never mutated.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { writeRunMirror } from "../../src/durable/mirror.js";
import { isTerminalRunStatus, type RunRecord } from "../../src/engine/index.js";
import { isArgosError } from "../../src/errors.js";
import { loadPlaybook } from "../../src/playbook/index.js";
import type { TargetCatalog } from "../../src/paseo/model-catalog.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo } from "../support/git.js";
import { drive, driveIo, makeTempHome } from "./support.js";

// ------------------------------------------------------------------ fixtures

const dirs: string[] = [];
const hosts: ArgosHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop();
    if (host !== undefined) await host.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A repository holding `.argos/playbooks/<id>.yaml`. */
function makeRepo(books: Readonly<Record<string, string>>): string {
  const repo = mkdtempSync(join(tmpdir(), "argos-fork-"));
  dirs.push(repo);
  mkdirSync(join(repo, ".argos", "playbooks"), { recursive: true });
  for (const [id, yaml] of Object.entries(books)) writeBook(repo, id, yaml);
  return repo;
}

function writeBook(repo: string, id: string, yaml: string): void {
  const dir = join(repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yaml`), yaml, "utf8");
}

/** `a → b → c`; `b`'s prompt is the thing an operator iterates on. */
function book(options: { readonly bPrompt?: string; readonly isolation?: string } = {}): string {
  const bPrompt = options.bPrompt ?? "Review the plan.";
  return `title: Fork fixture
inputs:
  topic:
    type: string
${options.isolation === undefined ? "" : `isolation:\n  mode: ${options.isolation}\n`}steps:
  - id: a
    prompt: "Draft the plan for {{ inputs.topic }}."
  - id: b
    needs: [a]
    prompt: "${bPrompt}"
  - id: c
    needs: [b]
    prompt: "Publish the plan."
`;
}

const GATED_BOOK = `title: Fork gate
steps:
  - id: draft
    prompt: "Draft the change."
  - id: review
    needs: [draft]
    gate:
      question: "Ship it?"
      choices:
        approve:
          label: Approve
        revise:
          label: Revise
          comment: required
    on:
      approve:
        end: approved
`;

const LOOP_BOOK = `title: Fork loop
steps:
  - id: fix
    prompt: "Fix it."
  - id: review
    needs: [fix]
    prompt: "Review the fix."
    outcomes: [changes, approve]
    on:
      changes:
        goto: fix
        max_loops: 1
      approve:
        end: approved
`;

const SCRIPT_BOOK = `title: Fork script
steps:
  - id: a
    prompt: "Draft the plan."
  - id: b
    needs: [a]
    script: review.sh
`;

/**
 * `review` asks for one more round on the parent and two on a fork, so the fork test can prove the
 * loop counter was reset: with an inherited counter the second `changes` would hit `max_loops`
 * and park on a loop-limit gate instead of finishing.
 */
function reviewOutcome(agent: { readonly stepId: string; readonly attempt: number; readonly runId: string }): string {
  if (agent.stepId !== "review") return "success";
  // The parent loops once (attempts 1–2); a fork inherits the attempt list, so its first review
  // is attempt 3 and it must still be allowed to loop — that is the counter reset under test.
  return agent.attempt <= (agent.runId === "run-parent" ? 1 : 3) ? "changes" : "approve";
}

/** Deterministic outputs and outcomes, keyed per step and attempt. */
function makeExecutor(): FakeExecutor {
  return new FakeExecutor({
    complete: (agent) => ({
      outcome: reviewOutcome(agent),
      outputs: { marker: `${agent.stepId}-${agent.attempt}` },
    }),
  });
}

async function openHost(options: {
  readonly clock: FakeClock;
  readonly executor?: FakeExecutor;
  readonly home?: string;
  readonly modelCatalog?: TargetCatalog;
}): Promise<ArgosHost> {
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    clock: options.clock,
    executor: options.executor ?? makeExecutor(),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  hosts.push(host);
  return host;
}

async function driveToTerminal(
  host: ArgosHost,
  clock: FakeClock,
  runId: string,
  options: { readonly stepMs?: number; readonly maxRounds?: number } = {},
): Promise<RunRecord> {
  await drive(
    clock,
    async () => {
      const record = (await host.getRun(runId))?.record;
      return record !== undefined && isTerminalRunStatus(record.status);
    },
    { stepMs: options.stepMs ?? 1_000, maxRounds: options.maxRounds ?? 40 },
  );
  const record = (await host.getRun(runId))?.record;
  if (record === undefined) throw new Error(`run ${runId} vanished`);
  return record;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

function codeOf(error: unknown): string | undefined {
  return isArgosError(error) ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** A completed parent on `a → b → c`. */
async function completedParent(repo: string, options: { readonly deadline?: number } = {}) {
  const clock = new FakeClock();
  const executor = makeExecutor();
  const host = await openHost({ clock, executor });
  const started = await host.startRun({
    ir: loadPlaybook(repo, "fork"),
    inputs: { topic: "v1" },
    cwd: repo,
    id: "run-parent",
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
  const record = await driveToTerminal(host, clock, started.runId);
  return { host, clock, executor, runId: started.runId, taskId: started.taskId, record };
}

// ------------------------------------------------------------------ tests

describe("forkRun: the iterate loop (S-FR1–FR6)", () => {
  it("re-runs only the fork step and its downstream steps, with the edited definition", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    expect(parent.record.status).toBe("completed");
    const prefixAttempts = parent.record.steps["a"]?.attempts.length;

    // The operator edits `b`'s prompt and forks there.
    writeBook(repo, "fork", book({ bPrompt: "Review the plan for regressions." }));
    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    expect(forked.runId).toBe("run-fork");
    expect(forked.runId).not.toBe(parent.runId);

    const record = await driveToTerminal(parent.host, parent.clock, forked.runId);

    // Prefix preserved: `a` never re-ran, and its outputs and attempts are the parent's.
    expect(record.steps["a"]?.status).toBe("completed");
    expect(record.steps["a"]?.outputs).toEqual({ marker: "a-1" });
    expect(record.steps["a"]?.attempts).toHaveLength(prefixAttempts ?? 1);
    expect(parent.executor.agentsForStep("a")).toHaveLength(1);

    // The fork step and everything downstream re-ran, as attempt 2 of each step.
    expect(record.steps["b"]?.outputs).toEqual({ marker: "b-2" });
    expect(record.steps["c"]?.outputs).toEqual({ marker: "c-2" });
    expect(parent.executor.agentsForStep("b")).toHaveLength(2);
    expect(parent.executor.agentsForStep("c")).toHaveLength(2);

    // The whole point: the new prompt reached the executor.
    expect(parent.executor.agentsForStep("b")[1]?.prompt).toContain("for regressions");
  });

  it("never mutates the parent document", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    const before = JSON.stringify((await parent.host.getRun(parent.runId))?.record);

    writeBook(repo, "fork", book({ bPrompt: "Review differently." }));
    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    await driveToTerminal(parent.host, parent.clock, forked.runId);

    expect(JSON.stringify((await parent.host.getRun(parent.runId))?.record)).toBe(before);
  });

  it("records fork provenance and starts its history with run_started + forked_from", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    const parentRecord = parent.record;

    writeBook(repo, "fork", book({ bPrompt: "Review with a rubric." }));
    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    const record = (await parent.host.getRun(forked.runId))?.record;
    const history = (await parent.host.getHistory(forked.runId))?.events ?? [];

    expect(record?.forkedFrom).toEqual({
      runId: parent.runId,
      stepId: "b",
      fromHash: parentRecord.playbookHash,
      toHash: record?.playbookHash,
    });
    expect(record?.playbookHash).not.toBe(parentRecord.playbookHash);
    // One document, one IR: the fork's own hash always matches the IR it carries.
    expect(record?.ir.hash).toBe(record?.playbookHash);

    expect(history[0]?.type).toBe("run_started");
    expect(history[1]?.type).toBe("forked_from");
    expect(history[1]?.stepId).toBe("b");
    expect(history[1]?.detail).toBe(`${parent.runId}@b`);
    // Never a YAML value, only ids.
    expect(JSON.stringify(history)).not.toContain("Review with a rubric");
  });

  it("is a no-op fork when the definition did not change", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);

    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    const record = (await parent.host.getRun(forked.runId))?.record;
    expect(record?.forkedFrom?.fromHash).toBe(record?.forkedFrom?.toHash);
    expect(record?.steps["b"]?.status).toBe("pending");
    await driveToTerminal(parent.host, parent.clock, forked.runId);
    expect((await parent.host.getRun(forked.runId))?.record.status).toBe("completed");
  });
});

describe("forkRun: state that is deliberately not inherited (S-FR7)", () => {
  it("drops the parent's decided gates", async () => {
    const repo = makeRepo({ gated: GATED_BOOK });
    const clock = new FakeClock();
    const host = await openHost({ clock });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "gated"),
      inputs: {},
      cwd: repo,
      id: "run-parent",
    });
    await drive(clock, async () => (await host.getRun(started.runId))?.record.gates.length === 1);
    await host.decideGate(started.runId, "review:1", "approve", { decidedBy: "thao" });
    const parentRecord = await driveToTerminal(host, clock, started.runId);
    expect(parentRecord.gates).toHaveLength(1);

    const forked = await host.forkRun(started.runId, "draft", { id: "run-fork" });
    const record = (await host.getRun(forked.runId))?.record;
    expect(record?.gates).toEqual([]);
    expect(record?.steps["draft"]?.status).toBe("pending");
    // A fresh gate counter: the fork's own first gate will be `review:1` again, not `:2`.
    const history = (await host.getHistory(forked.runId))?.events ?? [];
    expect(history.map((event) => event.type)).not.toContain("gate_decided");
  });

  it("resets loop counters so a fork is not blocked by the parent's max_loops", async () => {
    const repo = makeRepo({ loopy: LOOP_BOOK });
    const clock = new FakeClock();
    const executor = makeExecutor();
    const host = await openHost({ clock, executor });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "loopy"),
      inputs: {},
      cwd: repo,
      id: "run-parent",
    });
    const parentRecord = await driveToTerminal(host, clock, started.runId);
    expect(parentRecord.loops["review->fix"]).toBe(1);

    const forked = await host.forkRun(started.runId, "fix", { id: "run-fork" });
    const record = (await host.getRun(forked.runId))?.record;
    expect(record?.loops).toEqual({});
    expect(record?.loopAllowance).toEqual({});

    // The reset loop counter is what makes the first re-run possible.
    const replay = await driveToTerminal(host, clock, forked.runId);
    expect(replay.status).toBe("completed");
    expect(replay.loops["review->fix"]).toBe(1);
  });

  it("drops the parent's deadline and schedule trigger", async () => {
    const repo = makeRepo({ fork: book() });
    const clock = new FakeClock();
    const deadline = new FakeClock().now() + 3_600_000;
    const parent = await completedParent(repo, { deadline });
    expect(parent.record.deadline).toBe(deadline);

    // A schedule fire's provenance is the parent's, not the fork's: otherwise one fire would show
    // up as two runs in `argos ls --schedule`.
    const trigger = { kind: "schedule", scheduleId: "nightly", fireAt: 1, reason: "cron" } as const;
    const doc = await parent.host.getRun(parent.runId);
    const mirrored: RunRecord = { ...(JSON.parse(JSON.stringify(doc?.record)) as RunRecord), trigger };
    await parent.host.harness.commit(async (tx) => {
      await writeRunMirror(tx, Number(doc?.taskId) as TaskId, mirrored);
    }, parent.host.context);

    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    const record = (await parent.host.getRun(forked.runId))?.record;
    expect(record?.deadline).toBeUndefined();
    expect(record?.trigger).toBeUndefined();
    expect(record?.forkedFrom?.runId).toBe(parent.runId);
  });
});

describe("forkRun: refusals (S-FR4, S-FR10)", () => {
  /** Fork `b` after rewriting the book, and return the thrown error. */
  async function refusalFor(
    yaml: string | undefined,
    options: { readonly stepId?: string; readonly runId?: string; readonly before?: (repo: string) => void } = {},
  ): Promise<unknown> {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    options.before?.(repo);
    if (yaml === undefined) rmSync(join(repo, ".argos", "playbooks", "fork.yaml"));
    else writeBook(repo, "fork", yaml);
    return errorOf(
      parent.host.forkRun(options.runId ?? parent.runId, options.stepId ?? "b", { id: "run-fork" }),
    );
  }

  it("refuses an edit upstream of the fork point with definition_conflict", async () => {
    const upstream = book().replace(
      'prompt: "Draft the plan for {{ inputs.topic }}."',
      'prompt: "Draft a completely different plan."',
    );
    const error = await refusalFor(upstream);
    expect(codeOf(error)).toBe("definition_conflict");
    expect(messageOf(error)).toContain("fork point b");
    const issues = isArgosError(error) ? error.issues ?? [] : [];
    expect(issues.map((issue) => issue.path)).toEqual(["steps.a"]);
    expect(issues[0]?.stepId).toBe("a");
    // Ids and paths only, never a YAML value.
    expect(messageOf(error)).not.toContain("completely different");
  });

  it("refuses an added step, a changed input, isolation, and after-tasks", async () => {
    const cases: ReadonlyArray<{ readonly yaml: string; readonly path: string }> = [
      {
        yaml: book().replace(
          `prompt: "Publish the plan."`,
          `prompt: "Publish the plan."\n  - id: d\n    needs: [c]\n    prompt: "Notify the team."`,
        ),
        path: "steps",
      },
      {
        yaml: book().replace(`    type: string\n`, `    type: string\n    required: true\n`),
        path: "inputs.topic",
      },
      { yaml: book({ isolation: "worktree" }), path: "isolation" },
      {
        yaml: `${book()}after:
  - id: report
    steps:
      - id: report-1
        prompt: "Write the report."
`,
        path: "after",
      },
    ];
    for (const entry of cases) {
      const error = await refusalFor(entry.yaml);
      expect(codeOf(error), entry.path).toBe("definition_conflict");
      const issues = isArgosError(error) ? error.issues ?? [] : [];
      expect(issues.map((issue) => issue.path), entry.path).toContain(entry.path);
    }
  });

  it("allows an edit downstream of the fork point", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    writeBook(
      repo,
      "fork",
      book().replace('prompt: "Publish the plan."', 'prompt: "Publish the plan and notify."'),
    );
    const forked = await parent.host.forkRun(parent.runId, "b", { id: "run-fork" });
    expect(forked.runId).toBe("run-fork");
  });

  it("refuses a missing playbook, an unknown run or step, and a non-terminal parent", async () => {
    expect(codeOf(await refusalFor(undefined))).toBe("playbook_missing");
    expect(codeOf(await refusalFor(book(), { runId: "run-nope" }))).toBe("run_unknown");
    expect(codeOf(await refusalFor(book(), { stepId: "nope" }))).toBe("step_unknown");

    const repo = makeRepo({ fork: book() });
    const clock = new FakeClock();
    const host = await openHost({ clock });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "fork"),
      inputs: { topic: "v1" },
      cwd: repo,
      id: "run-live",
    });
    const error = await errorOf(host.forkRun(started.runId, "b", { id: "run-fork" }));
    expect(codeOf(error)).toBe("run_terminal");
    // Nothing was created by any refusal.
    expect((await host.listRuns()).map((doc) => doc.record.id)).toEqual(["run-live"]);
  });

  it("refuses an off-catalog target with model_unavailable", async () => {
    const repo = makeRepo({ fork: book() });
    let forbid = false;
    const modelCatalog: TargetCatalog = {
      missingTargets: () => (forbid ? ["claude/ghost"] : []),
    };
    const clock = new FakeClock();
    const host = await openHost({ clock, modelCatalog });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "fork"),
      inputs: { topic: "v1" },
      cwd: repo,
      id: "run-parent",
    });
    await driveToTerminal(host, clock, started.runId);

    forbid = true;
    const error = await errorOf(host.forkRun(started.runId, "b", { id: "run-fork" }));
    expect(codeOf(error)).toBe("model_unavailable");
    expect((await host.listRuns()).map((doc) => doc.record.id)).toEqual(["run-parent"]);
  });

  it("refuses a cwd that no longer exists with invalid_request", async () => {
    const repo = makeRepo({ fork: book() });
    const parent = await completedParent(repo);
    rmSync(repo, { recursive: true, force: true });
    const error = await errorOf(parent.host.forkRun(parent.runId, "b", { id: "run-fork" }));
    expect(codeOf(error)).toBe("invalid_request");
  });
});

describe("forkRun: scripts (S-FR8)", () => {
  function writeScript(repo: string, body: string): void {
    const dir = join(repo, ".argos", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review.sh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  it("re-pins a changed script in the closure and reports script_repinned", async () => {
    const repo = makeRepo({ scripted: SCRIPT_BOOK });
    writeScript(repo, "echo ok");
    const clock = new FakeClock();
    const host = await openHost({ clock });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "scripted"),
      inputs: {},
      cwd: repo,
      id: "run-parent",
    });
    await driveIo(clock, async () => isTerminalRunStatus((await host.getRun(started.runId))?.record.status ?? "running"));
    const parentRecord = (await host.getRun(started.runId))?.record;
    const before = parentRecord?.scripts?.["review.sh"]?.sha256;
    expect(before).toBeDefined();

    writeScript(repo, "echo changed");
    const forked = await host.forkRun(started.runId, "b", { id: "run-fork" });
    const record = (await host.getRun(forked.runId))?.record;
    const after = record?.scripts?.["review.sh"]?.sha256;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);

    const history = (await host.getHistory(forked.runId))?.events ?? [];
    const repinned = history.find((event) => event.type === "script_repinned");
    expect(repinned?.stepId).toBe("b");
    expect(repinned?.detail).toBe(`review.sh: ${before} -> ${after}`);
  });

  it("refuses a fork whose closure names a script that is gone", async () => {
    const repo = makeRepo({ scripted: SCRIPT_BOOK });
    writeScript(repo, "echo ok");
    const clock = new FakeClock();
    const host = await openHost({ clock });
    const started = await host.startRun({
      ir: loadPlaybook(repo, "scripted"),
      inputs: {},
      cwd: repo,
      id: "run-parent",
    });
    await driveIo(clock, async () => isTerminalRunStatus((await host.getRun(started.runId))?.record.status ?? "running"));

    rmSync(join(repo, ".argos", "scripts", "review.sh"));
    const error = await errorOf(host.forkRun(started.runId, "b", { id: "run-fork" }));
    expect(codeOf(error)).toBe("playbook_invalid");
    expect(messageOf(error)).toContain("b");
    expect((await host.listRuns()).map((doc) => doc.record.id)).toEqual(["run-parent"]);
  });
});

describe("forkRun: isolation (S-FR11)", () => {
  it("gives the fork its own worktree on its own branch, cut from the parent's branch", async () => {
    const temp = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      writeBook(temp.repo, "fork", book());
      temp.git(["add", "-A"]);
      temp.git(["commit", "--quiet", "-m", "playbook"]);
      temp.git(["push", "--quiet", "origin", "main"]);

      const clock = new FakeClock();
      const host = await openHost({ clock, home, executor: makeExecutor() });
      const started = await host.startRun({
        ir: loadPlaybook(temp.repo, "fork"),
        inputs: { topic: "v1" },
        cwd: temp.repo,
        id: "run-parent",
        isolation: { mode: "worktree" },
      });
      const parentRecord = await driveToTerminal(host, clock, started.runId, { stepMs: 1_000 });
      const parentWorktree = parentRecord.worktree;
      expect(parentWorktree?.branch).toBe("argos/run-parent");

      // Work the parent's run produced, committed on its branch.
      writeFileSync(join(parentWorktree?.path as string, "plan.md"), "the plan\n", "utf8");
      temp.git(["add", "plan.md"], parentWorktree?.path);
      temp.git(["commit", "--quiet", "-m", "plan"], parentWorktree?.path);
      const parentHead = temp.git(["rev-parse", "HEAD"], parentWorktree?.path);

      const forked = await host.forkRun(started.runId, "b", { id: "run-fork" });
      const record = (await host.getRun(forked.runId))?.record;

      expect(record?.worktree?.path).toBe(join(home, "worktrees", "run-fork"));
      expect(record?.worktree?.branch).toBe("argos/run-fork");
      expect(record?.worktree?.baseSha).toBe(parentHead);
      expect(record?.worktree?.path).not.toBe(parentWorktree?.path);
      // The parent's checkout is untouched and still branch-owning.
      expect(temp.git(["rev-parse", "--abbrev-ref", "HEAD"], parentWorktree?.path)).toBe(
        "argos/run-parent",
      );
      expect(existsSync(join(record?.worktree?.path as string, "plan.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
