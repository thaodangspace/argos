/**
 * The definition-freeze contract, measured at the seam an operator actually touches: the YAML file.
 *
 * A run stores the fully resolved IR + hash it started with and never reloads it (Invariants →
 * *Definition freeze*). `loadPlaybook`'s own tests prove the loader is read-only and deterministic,
 * and `fork.test.ts` proves `argos fork` re-runs an edited definition. What these tests pin is the
 * boundary in between, which is what an operator asks about after every edit:
 *
 * 1. a **new** run reads the edited file through `resolveRunRequest` (the shared front half of
 *    `POST /runs` and every schedule fire), so no cache can make it stale;
 * 2. a run already parked — here on a `loop_limit` gate — decides against the definition it
 *    started with, even when the edit raises `max_loops` and rewrites the loop's prompt;
 * 3. `retry` re-uses the record's IR instead of reloading the edit, so a retry is never a way to
 *    pick up a new definition (that is what `argos fork` is for).
 *
 * The scheduler half ("every fire reloads") lives next to the other fire tests, in
 * `schedule-fire.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { resolveRunRequest } from "../../src/durable/run-request.js";
import { isTerminalRunStatus, type RunRecord } from "../../src/engine/index.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive } from "./support.js";

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
  const repo = mkdtempSync(join(tmpdir(), "argos-freeze-"));
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
function linearBook(bPrompt: string): string {
  return `title: Linear fixture
steps:
  - id: a
    prompt: "Draft the plan."
  - id: b
    needs: [a]
    prompt: "${bPrompt}"
  - id: c
    needs: [b]
    prompt: "Publish the plan."
`;
}

/** `fix → review`, where `changes` returns to `fix` at most `maxLoops` times. */
function loopBook(options: { readonly maxLoops: number; readonly reviewPrompt: string }): string {
  return `title: Loop fixture
steps:
  - id: fix
    prompt: "Fix it."
  - id: review
    needs: [fix]
    prompt: "${options.reviewPrompt}"
    outcomes: [changes, approve]
    on:
      changes:
        goto: fix
        max_loops: ${options.maxLoops}
      approve:
        end: approved
`;
}

/**
 * Start one run exactly the way `POST /runs` and a schedule fire do: `resolveRunRequest` (cwd
 * validation → `loadPlaybook` → input coercion) hands the frozen IR to `startRun`.
 */
async function start(host: ArgosHost, repo: string, playbookId: string, id: string): Promise<string> {
  const resolved = resolveRunRequest({ playbookId, cwd: repo });
  const started = await host.startRun({
    ir: resolved.ir,
    inputs: resolved.inputs,
    cwd: resolved.cwd,
    id,
  });
  return started.runId;
}

async function openHost(clock: FakeClock, executor: FakeExecutor): Promise<ArgosHost> {
  const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
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

function promptOf(record: RunRecord, stepId: string): string | undefined {
  return record.ir.steps.find((step) => step.id === stepId)?.prompt;
}

// ------------------------------------------------------------------ tests

describe("the definition is frozen per run, the file is read per start", () => {
  it("a new run reads the edited YAML; the finished run keeps the definition it started with", async () => {
    const repo = makeRepo({ book: linearBook("Review the plan.") });
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) => ({ outputs: { marker: `${agent.stepId}-${agent.attempt}` } }),
    });
    const host = await openHost(clock, executor);

    const before = await start(host, repo, "book", "run-before-edit");
    const beforeRecord = await driveToTerminal(host, clock, before);
    expect(beforeRecord.status).toBe("completed");
    expect(promptOf(beforeRecord, "b")).toBe("Review the plan.");
    expect(executor.agentForStep("b").prompt).toBe("Review the plan.");

    // The operator edits `b`'s prompt between two runs; nothing else changes.
    writeBook(repo, "book", linearBook("Review the plan for regressions."));

    const after = await start(host, repo, "book", "run-after-edit");
    const afterRecord = await driveToTerminal(host, clock, after);
    expect(afterRecord.status).toBe("completed");

    // The second document carries the edit: a different hash, a matching IR, and the new prompt
    // reached the executor.
    expect(afterRecord.playbookHash).not.toBe(beforeRecord.playbookHash);
    expect(afterRecord.playbookHash).toBe(afterRecord.ir.hash);
    expect(promptOf(afterRecord, "b")).toBe("Review the plan for regressions.");
    expect(executor.latestAgentForStep("b")?.prompt).toBe("Review the plan for regressions.");

    // The first document is evidence, not a pointer to the file: it still holds what it ran.
    const reread = (await host.getRun(before))?.record;
    expect(reread?.playbookHash).toBe(beforeRecord.playbookHash);
    expect(reread === undefined ? undefined : promptOf(reread, "b")).toBe("Review the plan.");
  });

  it("a run parked on a loop-limit gate decides against its own `max_loops`, not the edited one", async () => {
    const repo = makeRepo({
      loop: loopBook({ maxLoops: 1, reviewPrompt: "Review the fix." }),
    });
    const clock = new FakeClock();
    // `review` always asks for another round, so the only thing that stops the loop is its limit.
    const executor = new FakeExecutor({
      complete: (agent) => ({ outcome: agent.stepId === "review" ? "changes" : "success" }),
    });
    const host = await openHost(clock, executor);

    const runId = await start(host, repo, "loop", "run-loop-freeze");
    await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1, {
      stepMs: 3_000,
      maxRounds: 30,
    });

    const parked = (await host.getRun(runId))?.record as RunRecord;
    expect(parked.gates.map((gate) => gate.id)).toEqual(["review:1"]);
    expect(parked.gates[0]).toMatchObject({
      kind: "loop_limit",
      stepId: "review",
      edge: "review->fix",
      maxLoops: 1,
    });
    expect(parked.loops["review->fix"]).toBe(1);

    // While the gate is pending, the operator raises the limit to 5 and rewrites the prompt.
    writeBook(repo, "loop", loopBook({ maxLoops: 5, reviewPrompt: "Review under the new policy." }));

    await host.decideGate(runId, "review:1", "approve", { comment: "one more pass" });

    // With the frozen `max_loops: 1` the approval buys exactly one traversal, so the next
    // `changes` parks on a second gate (`review:2`) instead of running up to the edited limit.
    await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 2, {
      stepMs: 3_000,
      maxRounds: 40,
    });

    const second = (await host.getRun(runId))?.record as RunRecord;
    expect(second.gates.map((gate) => gate.id)).toEqual(["review:1", "review:2"]);
    expect(second.gates[1]).toMatchObject({ kind: "loop_limit", maxLoops: 1 });
    expect(second.loops["review->fix"]).toBe(2);
    expect(second.playbookHash).toBe(parked.playbookHash);

    // The edited prompt never reached an agent: every `review` attempt used the frozen text.
    expect(executor.agentsForStep("review").map((agent) => agent.prompt)).toEqual([
      "Review the fix.",
      "Review the fix.",
      "Review the fix.",
    ]);

    await host.decideGate(runId, "review:2", "reject");
    const finished = await driveToTerminal(host, clock, runId, { stepMs: 3_000, maxRounds: 20 });
    expect(finished.status).toBe("failed");
    expect(finished.steps["review"]?.errorCode).toBe("step_failed");
  });

  it("retry re-uses the record's IR, so a YAML edit is not picked up (fork is the reload path)", async () => {
    const repo = makeRepo({ book: linearBook("Review the plan.") });
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) => ({ outputs: { marker: `${agent.stepId}-${agent.attempt}` } }),
    });
    const host = await openHost(clock, executor);

    const runId = await start(host, repo, "book", "run-retry-freeze");
    const before = await driveToTerminal(host, clock, runId);
    expect(before.status).toBe("completed");
    expect(executor.agentsForStep("b")).toHaveLength(1);

    writeBook(repo, "book", linearBook("Review under the new policy."));

    // Same run id, so the frozen IR is reused: a retry is a new attempt, not a new run.
    const retried = await host.retryStep(runId, "b");
    expect(retried.runId).toBe(runId);

    const after = await driveToTerminal(host, clock, runId);
    expect(after.status).toBe("completed");
    expect(after.playbookHash).toBe(before.playbookHash);
    expect(promptOf(after, "b")).toBe("Review the plan.");
    expect(executor.agentsForStep("b")).toHaveLength(2);
    expect(executor.latestAgentForStep("b")?.prompt).toBe("Review the plan.");
    expect(executor.agentsForStep("b").some((agent) => agent.prompt?.includes("new policy"))).toBe(
      false,
    );
  });
});
