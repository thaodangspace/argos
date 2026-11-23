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
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type { StepCheckpoint } from "../../src/durable/tasks/step.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive, singleStepPlaybook } from "./support.js";

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
