/**
 * Launch-time transient executor failures (FR1–FR7, FR9).
 *
 * An executor that is momentarily unreachable **at the moment a step launches an agent** used to
 * fail the step (and the run) on the first throw. The step now parks in `launch` and re-enters the
 * same adopt-or-create launch with the same `requestId` after the engine's deterministic
 * 1s/2s/4s… backoff, until the step deadline; at the deadline it fails with the transient code
 * (`paseo_unreachable` / `executor_unreachable`), never `step_timeout`, and `retries` is not
 * consumed because no agent ever ran.
 *
 * The five cases below pin: the park/backoff/one-creation path, the deadline failure code, that a
 * non-transient code still fails on the first throw, that the retry allowance survives a launch
 * outage, and that the rule keys on the code (not on the executor id).
 *
 * A second group proves the claims the park path rests on: the retry is durable across a host
 * restart (same `requestId`, one creation in total), the read-only snapshot taken in `locate` still
 * governs the whole step when the launch was retried (a changed tree still fails
 * `readonly_violation`), a launch that created before it threw is adopted instead of duplicated on
 * `hc`, and a daemon that cannot filter labels still refuses `launch_uncertain` instead of adopting
 * blindly.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../../src/durable/context.js";
import type { StepCheckpoint } from "../../src/durable/tasks/step.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { ArgosError } from "../../src/errors.js";
import type { PlaybookIR, RoleIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo } from "../support/git.js";
import { drive, driveIo, flush, makeTempHome, singleStepPlaybook } from "./support.js";

interface StepState {
  readonly status?: string;
  readonly until?: number;
  readonly checkpoint?: StepCheckpoint;
}

/** The live `argos.step` task of one step id, as `inspect()` reports it. */
async function stepTask(
  host: ArgosHost,
  stepId: string,
): Promise<{ readonly id: string; readonly state: StepState } | undefined> {
  const inspection = await host.inspect();
  const task = inspection.tasks.find(
    (candidate) =>
      candidate.record.kind === "argos.step" &&
      (candidate.record.input as { stepId?: string }).stepId === stepId,
  );
  if (task === undefined) return undefined;
  return { id: String(task.record.id), state: task.record.state as StepState };
}

async function stepState(host: ArgosHost, stepId: string): Promise<StepState | undefined> {
  return (await stepTask(host, stepId))?.state;
}

async function runStatus(host: ArgosHost, runId: string): Promise<string | undefined> {
  return (await host.getRun(runId))?.record.status;
}

describe("launch-time transient failures (FR1, FR2, FR5, FR7, FR9)", () => {
  it("parks, retries the same request id, and completes after the executor recovers", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-launch-retry";
      const requestId = `argos:${runId}:a:1`;
      // Two refused launches, then the executor is reachable again.
      executor.failLaunch(requestId, "paseo_unreachable", 2);
      await host.startRun({
        ir: singleStepPlaybook({ pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-retry",
        id: runId,
      });

      // First throw: parked in `launch`, same identity, one-second backoff, no agent.
      await drive(clock, async () => (await stepState(host, "a"))?.status === "sleeping", {
        stepMs: 0,
      });
      const first = await stepState(host, "a");
      expect(first?.checkpoint).toMatchObject({
        phase: "launch",
        launchFailures: 1,
        launchErrorCode: "paseo_unreachable",
        requestId,
        attempt: 1,
        launchAttempted: true,
      });
      expect(first?.until).toBe(clock.now() + 1_000);
      expect(await runStatus(host, runId)).toBe("running");
      expect(executor.launchCalls).toEqual([requestId]);
      expect(executor.creations).toEqual([]);

      // Second throw: same request id, doubled backoff, still no agent.
      await clock.advance(1_000);
      await drive(
        clock,
        async () => (await stepState(host, "a"))?.checkpoint?.launchFailures === 2,
        { stepMs: 0 },
      );
      const second = await stepState(host, "a");
      expect(second?.checkpoint).toMatchObject({
        phase: "launch",
        launchFailures: 2,
        launchErrorCode: "paseo_unreachable",
        requestId,
      });
      expect(second?.until).toBe(clock.now() + 2_000);
      expect(executor.launchCalls).toEqual([requestId, requestId]);

      // Third launch succeeds: exactly one agent, created once, and the code is gone again.
      await drive(clock, () => executor.agents.size === 1, { stepMs: 1_000 });
      expect(executor.launchCalls).toEqual([requestId, requestId, requestId]);
      expect(executor.creations).toEqual([requestId]);
      const awaiting = await stepState(host, "a");
      expect(awaiting?.checkpoint).toMatchObject({ phase: "await", launchFailures: 2, attempt: 1 });
      expect(awaiting?.checkpoint?.launchErrorCode).toBeUndefined();

      executor.complete(requestId);
      await drive(clock, async () => (await runStatus(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["a"]?.outcome).toBe("success");
      // One dispatch attempt: the launch retries never advanced the engine's attempt.
      expect(record?.steps["a"]?.attempts).toHaveLength(1);
      expect(executor.creationsByStep()).toEqual({ a: 1 });
    } finally {
      await host.close();
    }
  });

  it("fails with the transient code at the step deadline and creates no agent", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-launch-deadline";
      const requestId = `argos:${runId}:a:1`;
      // The executor never comes back.
      executor.failLaunch(requestId, "paseo_unreachable", 1_000);
      await host.startRun({
        ir: singleStepPlaybook({ timeout: 5_000, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-deadline",
        id: runId,
      });
      await drive(clock, async () => (await stepState(host, "a"))?.status === "sleeping", {
        stepMs: 0,
      });
      const taskId = (await stepTask(host, "a"))?.id;

      await drive(clock, async () => (await runStatus(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 30,
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      // The code names the substrate that was down, never the clock.
      expect(record?.errorCode).toBe("paseo_unreachable");
      expect(record?.steps["a"]?.status).toBe("failed");
      expect(record?.steps["a"]?.errorCode).toBe("paseo_unreachable");
      // Nothing ever launched: the outage cost no agent, and the step retried rather than spinning.
      expect(executor.creationsByStep()).toEqual({});
      expect(executor.agents.size).toBe(0);
      expect(executor.launchCalls.length).toBeGreaterThanOrEqual(3);

      // The diagnostic survives in the task receipt (the live checkpoint is dropped at terminal).
      expect(taskId).toBeDefined();
      const task = await host.getTaskRecord(taskId ?? "");
      const state = task?.state as
        | { status?: string; outcome?: { result?: { detail?: string } } }
        | undefined;
      expect(state?.status).toBe("terminal");
      const detail = state?.outcome?.result?.detail ?? "";
      expect(detail).toContain("step deadline reached");
      expect(detail).toContain("paseo_unreachable");
      expect(detail).toContain("launch failed");
    } finally {
      await host.close();
    }
  });

  it("fails on the first throw when the code is not transient", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-launch-uncertain";
      const requestId = `argos:${runId}:a:1`;
      // Retrying `launch_uncertain` would risk exactly the duplicate it exists to prevent.
      executor.failLaunch(requestId, "launch_uncertain", 5);
      await host.startRun({
        ir: singleStepPlaybook({ timeout: 60_000, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-uncertain",
        id: runId,
      });

      await drive(clock, async () => (await runStatus(host, runId)) === "failed", { stepMs: 0 });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("launch_uncertain");
      expect(record?.steps["a"]?.errorCode).toBe("launch_uncertain");
      expect(executor.launchCalls).toEqual([requestId]);
      expect(executor.creationsByStep()).toEqual({});
    } finally {
      await host.close();
    }
  });

  it("does not consume the step's retries, so a genuine failure still retries", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-launch-retry-budget";
      const requestId = `argos:${runId}:a:1`;
      executor.failLaunch(requestId, "paseo_unreachable", 2);
      await host.startRun({
        ir: singleStepPlaybook({ retries: 1, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-retry-budget",
        id: runId,
      });

      await drive(clock, () => executor.agents.size === 1, { stepMs: 1_000, maxRounds: 20 });
      expect(executor.launchCalls).toEqual([requestId, requestId, requestId]);

      // The launched agent then fails for real: the untouched allowance buys a second attempt.
      executor.complete(requestId, { errorCode: "invalid_output" });
      await drive(clock, () => executor.agents.size === 2, { stepMs: 1_000, maxRounds: 20 });
      expect(executor.creations).toEqual([requestId, `${requestId}.1`]);

      executor.complete(`${requestId}.1`);
      await drive(clock, async () => (await runStatus(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["a"]?.attempts).toHaveLength(1);
      expect(executor.creationsByStep()).toEqual({ a: 2 });
    } finally {
      await host.close();
    }
  });

  it("applies to every executor id, not only paseo", async () => {
    const clock = new FakeClock();
    const paseo = new FakeExecutor();
    const hc = new FakeExecutor();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: paseo,
      executors: { hc },
    });
    try {
      const runId = "run-launch-retry-hc";
      const requestId = `argos:${runId}:a:1`;
      hc.failLaunch(requestId, "executor_unreachable", 2);
      await host.startRun({
        ir: singleStepPlaybook({ pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-retry-hc",
        id: runId,
        executor: "hc",
      });

      await drive(clock, async () => (await stepState(host, "a"))?.status === "sleeping", {
        stepMs: 0,
      });
      const parked = await stepState(host, "a");
      expect(parked?.checkpoint).toMatchObject({
        phase: "launch",
        launchFailures: 1,
        launchErrorCode: "executor_unreachable",
        requestId,
      });
      expect((await host.getRun(runId))?.record.executor).toBe("hc");

      await drive(clock, () => hc.agents.size === 1, { stepMs: 1_000, maxRounds: 20 });
      expect(hc.launchCalls).toEqual([requestId, requestId, requestId]);
      expect(hc.creationsByStep()).toEqual({ a: 1 });
      // The default substrate was never asked, before or after the retry.
      expect(paseo.launchCalls).toEqual([]);

      hc.complete(requestId);
      await drive(clock, async () => (await runStatus(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      expect((await host.getRun(runId))?.record.status).toBe("completed");
    } finally {
      await host.close();
    }
  });
});

/** A read-only role: the step snapshots the tree in `locate` and refuses any change afterwards. */
const READ_ONLY: RoleIR = {
  id: "reviewer",
  title: "Reviewer",
  readonly: true,
  instructions: "Read the change. Do not write.",
  fallbacks: [],
};

function reviewedPlaybook(): PlaybookIR {
  return playbook({
    id: "reviewed",
    steps: [step({ id: "review", role: READ_ONLY, pollMs: 1_000 })],
  });
}

/**
 * A daemon that cannot filter agents by label. Whether a create already happened is unknowable, so
 * once a launch intent exists it refuses `launch_uncertain` instead of adopting blindly.
 */
class LabelBlindExecutor extends FakeExecutor {
  override async launch(input: LaunchInput): Promise<AgentLaunch> {
    if (input.priorCreateAttempt === true) {
      this.launchCalls.push(input.requestId);
      throw new ArgosError(
        "launch_uncertain",
        `labels cannot be filtered: refusing to adopt ${input.requestId} blindly`,
      );
    }
    return super.launch(input);
  }
}

/** A fake executor whose first status poll writes inside the working tree (a violating agent). */
class WritingExecutor implements StepExecutor {
  #wrote = false;

  constructor(
    private readonly inner: FakeExecutor,
    private readonly relativePath: string,
  ) {}

  async launch(input: LaunchInput): Promise<AgentLaunch> {
    return this.inner.launch(input);
  }

  async status(input: AgentStatusInput): Promise<StepAgentStatus> {
    if (!this.#wrote) {
      writeFileSync(join(input.cwd, this.relativePath), "the step should not have written this\n");
      this.#wrote = true;
    }
    return this.inner.status(input);
  }
}

describe("launch retry across a restart, the read-only guard, and adoption (FR4, FR8, FR10)", () => {
  it("resumes the parked launch after a restart with the same request id and one creation", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const runId = "run-launch-restart";
    const requestId = `argos:${runId}:a:1`;
    executor.failLaunch(requestId, "paseo_unreachable", 1);

    const first = await ArgosHost.open({ home, clock, executor });
    try {
      await first.startRun({
        ir: singleStepPlaybook({ pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-restart",
        id: runId,
      });
      await drive(clock, async () => (await stepState(first, "a"))?.status === "sleeping", {
        stepMs: 0,
      });
      const parked = await stepState(first, "a");
      expect(parked?.checkpoint).toMatchObject({
        phase: "launch",
        launchFailures: 1,
        launchErrorCode: "paseo_unreachable",
        requestId,
        attempt: 1,
        launchAttempted: true,
      });
      expect(executor.launchCalls).toEqual([requestId]);
      expect(executor.creations).toEqual([]);
    } finally {
      await first.close();
    }

    // A second lifetime: same home (the durable state), same executor (the daemon), same clock
    // instant. `blockLaunch` holds the resumed launch so its checkpoint can be read mid-flight.
    executor.blockLaunch(requestId);
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      await flush();
      await drive(clock2, () => executor.launchCalls.length >= 2, { stepMs: 1_000, maxRounds: 20 });

      // The resumed task re-entered `launch` — not `locate`, not a fresh dispatch — with every
      // committed identity field intact, so the adopt-or-create decision is the same one.
      const resumed = await stepState(second, "a");
      expect(resumed?.checkpoint).toMatchObject({
        phase: "launch",
        requestId,
        attempt: 1,
        launchFailures: 1,
        launchAttempted: true,
      });
      expect(resumed?.checkpoint?.launchErrorCode).toBe("paseo_unreachable");
      expect(executor.launchCalls).toEqual([requestId, requestId]);
      expect(executor.creations).toEqual([requestId]);

      executor.releaseLaunch(requestId);
      executor.complete(requestId);
      await drive(clock2, async () => (await runStatus(second, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });

      const record = (await second.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.errorCode).toBeUndefined();
      // One dispatch attempt and one launch decision per lifetime; one creation in total.
      expect(record?.steps["a"]?.attempts).toHaveLength(1);
      expect(executor.launchCalls).toEqual([requestId, requestId]);
      expect(executor.creationsByStep()).toEqual({ a: 1 });
      expect(executor.callsForStep("a")).toHaveLength(1);
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("fails a read-only step whose retried launch let the agent change the tree", async () => {
    const repo = makeTempRepo();
    const clock = new FakeClock();
    const inner = new FakeExecutor();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: new WritingExecutor(inner, "agent-note.txt"),
    });
    try {
      const runId = "run-readonly-launch-retry";
      const requestId = `argos:${runId}:review:1`;
      inner.failLaunch(requestId, "paseo_unreachable", 1);
      await host.startRun({ ir: reviewedPlaybook(), inputs: {}, cwd: repo.repo, id: runId });

      // `locate` committed the "before" snapshot ahead of the first (refused) launch.
      await driveIo(clock, async () => (await stepState(host, "review"))?.checkpoint?.launchFailures === 1);
      const parked = await stepState(host, "review");
      expect(parked?.checkpoint?.phase).toBe("launch");
      expect(parked?.checkpoint?.snapshotBefore?.head).toBe(repo.headSha);
      expect(parked?.checkpoint?.snapshotBefore?.files).toEqual([]);
      expect(inner.creations).toEqual([]);

      // The retry never re-enters `locate`, so that same snapshot still governs the attempt.
      await driveIo(clock, async () => (await stepState(host, "review"))?.checkpoint?.phase === "await");
      const awaited = await stepState(host, "review");
      expect(awaited?.checkpoint?.snapshotBefore).toEqual(parked?.checkpoint?.snapshotBefore);
      expect(inner.launchCalls).toEqual([requestId, requestId]);
      expect(inner.creations).toEqual([requestId]);

      inner.complete(requestId);
      await driveIo(clock, async () => (await runStatus(host, runId)) === "failed");

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("readonly_violation");
      expect(record?.steps["review"]?.errorCode).toBe("readonly_violation");
      // The guard detects, it does not prevent: the change is still there.
      expect(existsSync(join(repo.repo, "agent-note.txt"))).toBe(true);
    } finally {
      await host.close();
      repo.cleanup();
    }
  });

  it("completes a retried read-only step when the turn leaves the tree alone", async () => {
    const repo = makeTempRepo();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-readonly-launch-retry-clean";
      const requestId = `argos:${runId}:review:1`;
      executor.failLaunch(requestId, "paseo_unreachable", 1);
      await host.startRun({ ir: reviewedPlaybook(), inputs: {}, cwd: repo.repo, id: runId });

      await driveIo(clock, async () => (await stepState(host, "review"))?.checkpoint?.launchFailures === 1);
      await driveIo(clock, () => executor.agents.size === 1);
      executor.completeAll();
      await driveIo(clock, async () => (await runStatus(host, runId)) === "completed");

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.errorCode).toBeUndefined();
      expect(record?.steps["review"]?.errorCode).toBeUndefined();
      expect(executor.launchCalls).toEqual([requestId, requestId]);
      expect(executor.creationsByStep()).toEqual({ review: 1 });
    } finally {
      await host.close();
      repo.cleanup();
    }
  });

  it("adopts the terminal a failed post-create launch left behind on hc", async () => {
    const clock = new FakeClock();
    const paseo = new FakeExecutor();
    const hc = new FakeExecutor();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock,
      executor: paseo,
      executors: { hc },
    });
    try {
      const runId = "run-launch-hc-adopt";
      const requestId = `argos:${runId}:a:1`;
      // herdr-core shape: `terminal.run` created the terminal, then the prompt delivery threw.
      hc.failLaunchAfterCreate(requestId, "executor_unreachable", 1);
      await host.startRun({
        ir: singleStepPlaybook({ pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-hc-adopt",
        id: runId,
        executor: "hc",
      });

      await drive(clock, async () => (await stepState(host, "a"))?.checkpoint?.launchFailures === 1, {
        stepMs: 0,
      });
      // The throw came *after* the create: the terminal exists and must not be created twice.
      expect(hc.launchCalls).toEqual([requestId]);
      expect(hc.creations).toEqual([requestId]);
      expect(hc.agents.size).toBe(1);

      await drive(clock, async () => (await stepState(host, "a"))?.checkpoint?.phase === "await", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      expect(hc.launchCalls).toEqual([requestId, requestId]);
      expect(hc.creations).toEqual([requestId]);

      hc.complete(requestId);
      await drive(clock, async () => (await runStatus(host, runId)) === "completed", {
        stepMs: 1_000,
        maxRounds: 20,
      });
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.errorCode).toBeUndefined();
      expect(record?.executor).toBe("hc");
      expect(hc.creationsByStep()).toEqual({ a: 1 });
      // The default substrate was never asked, before or after the retry.
      expect(paseo.launchCalls).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("still refuses launch_uncertain on the retry of a label-blind daemon", async () => {
    const clock = new FakeClock();
    const executor = new LabelBlindExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const runId = "run-launch-label-blind";
      const requestId = `argos:${runId}:a:1`;
      // The first launch is a plain transient refusal: nothing was created.
      executor.failLaunch(requestId, "paseo_unreachable", 1);
      await host.startRun({
        ir: singleStepPlaybook({ timeout: 60_000, pollMs: 1_000 }),
        inputs: {},
        cwd: "/tmp/argos-launch-label-blind",
        id: runId,
      });
      await drive(clock, async () => (await stepState(host, "a"))?.checkpoint?.launchFailures === 1, {
        stepMs: 0,
      });

      // The retry carries `priorCreateAttempt`, so the daemon refuses instead of adopting blindly.
      await drive(clock, async () => (await runStatus(host, runId)) === "failed", {
        stepMs: 1_000,
        maxRounds: 10,
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("launch_uncertain");
      expect(record?.steps["a"]?.errorCode).toBe("launch_uncertain");
      // Exactly two launch calls: `launch_uncertain` is not transient, so there is no third.
      expect(executor.launchCalls).toEqual([requestId, requestId]);
      expect(executor.creations).toEqual([]);
      expect(executor.agents.size).toBe(0);
    } finally {
      await host.close();
    }
  });
});
