/**
 * Executor registry and record freeze (FR1, FR2, FR5, FR6, FR7, FR17).
 *
 * Two recording fake executors stand in for two substrates: `paseo` (the host's `executor` option,
 * unchanged) and `hc` (an entry of `executors`). The suite proves the four properties the registry
 * exists for:
 *
 * - a run names its executor in `RunRecord`, and a `paseo` record keeps the key absent (byte
 *   identity is the contract);
 * - a step child is dispatched through the executor the record names;
 * - a restarted host keeps using it even when `defaultExecutor` changed, and never silently falls
 *   back to the default when the adapter is gone;
 * - an executor nobody registered refuses the start before any task, index entry, or worktree.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";

import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import { createRunRecord, hydrateRunRecord } from "../../src/engine/index.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { isArgosError } from "../../src/errors.js";
import { executorIdFor, normalizeExecutorId } from "../../src/executor/model.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import {
  afterPlaybook,
  drive,
  makeTempHome,
  singleStepPlaybook,
} from "./support.js";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

/** Run a synchronous call and return what it threw (`undefined` when it did not). */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (cause) {
    return cause;
  }
}

/**
 * A `StepExecutor` that delegates to a {@link FakeExecutor} and counts what the step task asked
 * for. The counters are how the tests prove *which* substrate a child task called, including after
 * a host reopen (`status()` is the only call a resumed `await` makes).
 */
class RecordingExecutor implements StepExecutor {
  readonly calls = { launches: 0, polls: 0 };

  constructor(readonly fake: FakeExecutor) {}

  async launch(input: LaunchInput): Promise<AgentLaunch> {
    this.calls.launches += 1;
    return this.fake.launch(input);
  }

  async status(input: AgentStatusInput): Promise<StepAgentStatus> {
    this.calls.polls += 1;
    return this.fake.status(input);
  }
}

/** `a → b`: the chain a reopened host finishes, one step per dispatch. */
function chainPlaybook() {
  return playbook({
    id: "chain",
    steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] })],
  });
}

/**
 * A playbook that pins its own substrate (FR4/FR2). The IR is what the loader produces for
 * `executor: hc`, so the host resolves the substrate from the definition rather than from a flag.
 */
function pinnedPlaybook(): PlaybookIR {
  return { ...singleStepPlaybook(), executor: "hc" };
}

describe("executor ids (FR1)", () => {
  it("normalizes aliases, trims, and ignores case", () => {
    expect(normalizeExecutorId("paseo")).toBe("paseo");
    expect(normalizeExecutorId("hc")).toBe("hc");
    expect(normalizeExecutorId("herdr")).toBe("hc");
    expect(normalizeExecutorId("herdr-core")).toBe("hc");
    expect(normalizeExecutorId("  Herdr-Core ")).toBe("hc");
    expect(executorIdFor("nope")).toBeUndefined();
  });

  it("refuses an unknown id as invalid_request for the caller-facing gate", () => {
    const error = thrownBy(() => normalizeExecutorId("nope"));
    expect(isArgosError(error) && error.code).toBe("invalid_request");
  });
});

describe("RunRecord.executor (FR5)", () => {
  it("omits the key for paseo and round-trips byte-for-byte", () => {
    const ir = singleStepPlaybook();
    const base = { id: "run-paseo", ir, inputs: {}, cwd: "/tmp/argos-executor", now: 10 };

    const implicit = createRunRecord(base);
    expect(Object.hasOwn(implicit, "executor")).toBe(false);
    expect(implicit.executor).toBeUndefined();

    const explicit = createRunRecord({ ...base, id: "run-paseo-explicit", executor: "paseo" });
    expect(Object.hasOwn(explicit, "executor")).toBe(false);

    // A record written before the registry existed hydrates unchanged, and "absent" means paseo.
    const json = JSON.stringify(implicit);
    expect(json).not.toContain('"executor"');
    const hydrated = hydrateRunRecord(json);
    expect(hydrated.executor).toBeUndefined();
    expect(hydrated.executor ?? "paseo").toBe("paseo");
    expect(JSON.stringify(hydrated)).toBe(json);
  });

  it("stores a non-default executor and round-trips it byte-for-byte", () => {
    const record = createRunRecord({
      id: "run-hc",
      ir: singleStepPlaybook(),
      inputs: {},
      cwd: "/tmp/argos-executor",
      now: 10,
      executor: "hc",
    });
    expect(record.executor).toBe("hc");

    const json = JSON.stringify(record);
    expect(JSON.parse(json)["executor"]).toBe("hc");
    expect(JSON.stringify(hydrateRunRecord(json))).toBe(json);
  });
});

describe("executor registry (FR2, FR6, FR7)", () => {
  it("dispatches to the registered executor and resumes on it after a reopen", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const hc = new RecordingExecutor(new FakeExecutor());
    const runId = "run-executor-resume";

    const first = await ArgosHost.open({
      home,
      clock,
      executor: paseo,
      executors: { hc },
    });
    let pollsBeforeClose = 0;
    try {
      // `herdr-core` is an alias for `hc`: the record stores the canonical id (FR1).
      await first.startRun({
        ir: chainPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-executor-resume",
        id: runId,
        executor: "herdr-core",
      });
      await drive(clock, () => hc.fake.agentsForStep("a").length === 1);

      const record = (await first.getRun(runId))?.record;
      expect(record?.executor).toBe("hc");
      expect(paseo.calls.launches).toBe(0);
      expect(paseo.fake.agents.size).toBe(0);
      pollsBeforeClose = hc.calls.polls;
      expect(pollsBeforeClose).toBeGreaterThan(0);

      // Step a is parked mid-`await`; step b has not been dispatched yet.
      expect(hc.fake.agentsForStep("b")).toHaveLength(0);
    } finally {
      await first.close();
    }

    // The operator restarts `argos serve` with the default back on paseo.
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({
      home,
      clock: clock2,
      executor: paseo,
      executors: { hc },
      defaultExecutor: "paseo",
    });
    try {
      // The resumed `await` still polls hc, and step b is dispatched through hc after the reopen.
      await drive(
        clock2,
        async () => {
          hc.fake.completeAll();
          const doc = await second.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 30 },
      );

      const finished = (await second.getRun(runId))?.record;
      expect(finished?.status).toBe("completed");
      expect(finished?.executor).toBe("hc");
      expect(hc.calls.polls).toBeGreaterThan(pollsBeforeClose);
      expect(paseo.calls.polls).toBe(0);
      // Exactly one launch per step, all on hc: the restarted child adopted nothing on paseo.
      expect(hc.calls.launches).toBe(2);
      expect(paseo.calls.launches).toBe(0);
      expect(hc.fake.creationsByStep()).toEqual({ a: 1, b: 1 });
      expect(paseo.fake.agents.size).toBe(0);
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("takes the playbook's executor above the server default (FR2, FR4)", async () => {
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const hc = new RecordingExecutor(new FakeExecutor());
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: paseo,
      executors: { hc },
      defaultExecutor: "paseo",
    });
    try {
      const runId = "run-playbook-executor";
      await host.startRun({
        ir: pinnedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-playbook-executor",
        id: runId,
      });
      await drive(clock, () => hc.fake.agentsForStep("a").length === 1);

      // The definition named `hc`, so the record says `hc` and the child went to the hc fake.
      expect((await host.getRun(runId))?.record.executor).toBe("hc");
      expect(hc.calls.launches).toBe(1);
      expect(paseo.calls.launches).toBe(0);
      expect(paseo.fake.agents.size).toBe(0);

      hc.fake.completeAll();
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 3_000, maxRounds: 20 },
      );
      expect((await host.getRun(runId))?.record.status).toBe("completed");
      expect(hc.fake.creationsByStep()).toEqual({ a: 1 });
    } finally {
      await host.close();
    }
  });

  it("lets a request override the playbook's executor, and refuses one nobody registered", async () => {
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const hc = new RecordingExecutor(new FakeExecutor());
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: paseo,
      executors: { hc },
      defaultExecutor: "hc",
    });
    try {
      // The flag wins silently — the point of an override (spec "Edge Cases").
      const runId = "run-override-playbook";
      await host.startRun({
        ir: pinnedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-override-playbook",
        id: runId,
        executor: "paseo",
      });
      await drive(clock, () => paseo.fake.agentsForStep("a").length === 1);
      expect((await host.getRun(runId))?.record.executor).toBeUndefined();
      expect(hc.calls.launches).toBe(0);
    } finally {
      await host.close();
    }

    // A host that never registered hc refuses the playbook's own substrate before anything exists.
    const bare = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock: new FakeClock(clock.now()),
      executor: paseo,
    });
    try {
      const error = await errorOf(
        bare.startRun({
          ir: pinnedPlaybook(),
          inputs: {},
          cwd: "/tmp/argos-playbook-executor-missing",
          id: "run-playbook-executor-missing",
        }),
      );
      expect(isArgosError(error) && error.code).toBe("executor_unavailable");
      expect(await bare.listRuns()).toEqual([]);
      expect((await bare.inspect()).tasks).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it("fails the run with executor_unavailable, not a fallback, when the adapter is gone", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const hc = new RecordingExecutor(new FakeExecutor());
    const runId = "run-executor-missing";

    const first = await ArgosHost.open({
      home,
      clock,
      executor: paseo,
      executors: { hc },
    });
    let taskId = "";
    try {
      const started = await first.startRun({
        ir: chainPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-executor-missing",
        id: runId,
        executor: "hc",
      });
      taskId = started.taskId;
      await drive(clock, () => hc.fake.agentsForStep("a").length === 1);
    } finally {
      await first.close();
    }

    // The restarted host does not register hc: the frozen id must not be replaced by the default.
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({
      home,
      clock: clock2,
      executor: paseo,
      defaultExecutor: "paseo",
    });
    try {
      await drive(
        clock2,
        async () => (await second.getRun(runId))?.record.status === "failed",
        { stepMs: 3_000, maxRounds: 30 },
      );

      const record = (await second.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("executor_unavailable");
      expect(record?.steps["a"]?.errorCode).toBe("executor_unavailable");
      expect(record?.executor).toBe("hc");
      // The step failed; nothing fell back to the default executor.
      expect(paseo.calls.launches).toBe(0);
      expect(paseo.calls.polls).toBe(0);
      // A step failure is a completed task with an errorCode, never a task crash.
      expect(taskId).not.toBe("");
      const task = await second.getTaskRecord<unknown>(taskId);
      expect((task?.state as { status?: string } | undefined)?.status).toBe("terminal");
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("copies the parent's executor into an after-task child run", async () => {
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const hc = new RecordingExecutor(new FakeExecutor());
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: paseo,
      executors: { hc },
    });
    try {
      const { runId } = await host.startRun({
        ir: afterPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-executor-after",
        id: "run-executor-after",
        executor: "hc",
      });
      await drive(clock, () => hc.fake.agentsForStep("main").length === 1);
      expect((await host.getRun(runId))?.record.executor).toBe("hc");

      hc.fake.complete(`argos:${runId}:main:1`);
      await drive(clock, () => hc.fake.agentsForStep("report-step").length === 1);

      const reportAgent = hc.fake.agentForStep("report-step");
      const child = await host.getRun(reportAgent.runId);
      expect(child?.record.playbookId).toBe("with-after/report");
      expect(child?.record.executor).toBe("hc");
      expect(paseo.calls.launches).toBe(0);
      expect(hc.calls.launches).toBe(2);

      // Settle the child so the parent's after bookkeeping reaches a terminal state.
      hc.fake.complete(reportAgent.requestId);
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["report"]?.status === "completed",
        { stepMs: 3_000, maxRounds: 20 },
      );
      const settled = await host.getRun(reportAgent.runId);
      expect(settled?.record.status).toBe("completed");
      expect(settled?.record.executor).toBe("hc");
    } finally {
      await host.close();
    }
  });

  it("refuses an unregistered executor before any task or index entry exists (FR6)", async () => {
    const clock = new FakeClock();
    const paseo = new RecordingExecutor(new FakeExecutor());
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor: paseo });
    try {
      const ir = singleStepPlaybook();
      const args = { ir, inputs: {}, cwd: "/tmp/argos-executor-unknown" };

      // An id nobody knows, and a known id whose adapter this host never registered: both are
      // `executor_unavailable` at the host boundary (the 400/422 split is the RPC surface's job).
      for (const executor of ["nope", "hc"]) {
        const error = await errorOf(
          host.startRun({ ...args, id: `run-${executor}`, executor }),
        );
        expect(isArgosError(error) && error.code, executor).toBe("executor_unavailable");
        if (isArgosError(error)) expect(error.message).toContain("paseo");
        // The dry check (`argos schedule add|edit`) inherits the same refusal.
        const dry = await errorOf(host.checkRunStart({ ...args, executor }));
        expect(isArgosError(dry) && dry.code, executor).toBe("executor_unavailable");
      }

      expect(await host.listRuns()).toEqual([]);
      expect((await host.inspect()).tasks).toEqual([]);
      // No run task, hence no worktree either: the refusal precedes the worktree step.
      expect(paseo.calls.launches).toBe(0);
    } finally {
      await host.close();
    }
  });
});
