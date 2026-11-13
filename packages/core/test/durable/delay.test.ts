/**
 * `kind: delay` steps — `argos.delay` against the durable host on a fake clock.
 *
 * The regression this guards: a 30-minute pause written as a `sleep 1800` script failed with
 * `script_timeout` whenever `argos serve` restarted mid-pause, because the respawned script slept
 * the full 30 minutes again against the original deadline. A delay step commits one absolute wake
 * time, so a restart neither restarts nor stretches the pause.
 */

import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { DELAY_SLICE_MS, type DelayCheckpoint } from "../../src/durable/tasks/delay.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR, StepIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive, flush, makeTempHome } from "./support.js";

const MINUTE = 60_000;

function delayPlaybook(delay: NonNullable<StepIR["delay"]>, inputs: PlaybookIR["inputs"] = {}): PlaybookIR {
  return playbook({
    id: "paused",
    inputs,
    steps: [step({ id: "wait", kind: "delay", delay, pollMs: 0 })],
  });
}

async function statusOf(host: ArgosHost, runId: string): Promise<string | undefined> {
  return (await host.getRun(runId))?.record.status;
}

async function delayState(
  host: ArgosHost,
): Promise<{ status?: string; until?: number; checkpoint?: DelayCheckpoint } | undefined> {
  const inspection = await host.inspect();
  const task = inspection.tasks.find((candidate) => candidate.record.kind === "argos.delay");
  return task?.record.state as { status?: string; until?: number; checkpoint?: DelayCheckpoint } | undefined;
}

async function delayCheckpoint(host: ArgosHost): Promise<DelayCheckpoint | undefined> {
  return (await delayState(host))?.checkpoint;
}

describe("delay steps", () => {
  it("completes at the committed wake time, past the 30-minute default step timeout", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({ home, clock, executor: new FakeExecutor() });
    try {
      const start = clock.now();
      const { runId } = await host.startRun({ ir: delayPlaybook("45m"), inputs: {}, cwd: home });
      await drive(clock, async () => (await delayCheckpoint(host))?.phase === "wait", { stepMs: 0 });
      const armed = await delayCheckpoint(host);
      expect(armed?.phase === "wait" ? armed.until : undefined).toBe(start + 45 * MINUTE);
      // Parked one slice at a time, so a timer that fires late after a machine sleep is re-checked.
      expect(await delayState(host)).toMatchObject({ status: "sleeping", until: start + DELAY_SLICE_MS });

      await clock.advance(44 * MINUTE);
      await flush();
      expect(await statusOf(host, runId)).toBe("running");
      expect((await host.getRun(runId))?.record.steps["wait"]?.errorCode).toBeUndefined();

      await clock.advance(MINUTE);
      await drive(clock, async () => (await statusOf(host, runId)) !== "running", { stepMs: 0, maxRounds: 5 });
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["wait"]?.outcome).toBe("success");
      expect(record?.steps["wait"]?.attempts).toHaveLength(1);
      expect(record?.steps["wait"]?.attempts[0]?.outcome).toBe("completed");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("keeps the absolute wake time across a host restart (no reset, no timeout)", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor();
    const clock = new FakeClock();
    const first = await ArgosHost.open({ home, clock, executor });
    const start = clock.now();
    const { runId } = await first.startRun({ ir: delayPlaybook("30m"), inputs: {}, cwd: home });
    await drive(clock, async () => (await delayCheckpoint(first))?.phase === "wait", { stepMs: 0 });
    await clock.advance(13 * MINUTE);
    await first.close();

    // The restart that used to kill a `sleep 1800` script 13 minutes into the pause.
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      await flush();
      const resumed = await delayCheckpoint(second);
      expect(resumed?.phase === "wait" ? resumed.until : undefined).toBe(start + 30 * MINUTE);

      await clock2.advanceTo(start + 30 * MINUTE - 1);
      await flush();
      expect(await statusOf(second, runId)).toBe("running");

      await clock2.advance(1);
      await drive(clock2, async () => (await statusOf(second, runId)) !== "running", { stepMs: 0, maxRounds: 5 });
      expect(await statusOf(second, runId)).toBe("completed");
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("completes right away when the host comes back after the wake time", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor();
    const clock = new FakeClock();
    const first = await ArgosHost.open({ home, clock, executor });
    const { runId } = await first.startRun({ ir: delayPlaybook("30m"), inputs: {}, cwd: home });
    await drive(clock, async () => (await delayCheckpoint(first))?.phase === "wait", { stepMs: 0 });
    await first.close();

    const clock2 = new FakeClock(clock.now() + 2 * 3_600_000);
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      // No time passes after the reopen: the overdue wake fires on the first scheduling turn.
      await drive(clock2, async () => (await statusOf(second, runId)) !== "running", { stepMs: 0, maxRounds: 5 });
      expect(await statusOf(second, runId)).toBe("completed");
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("resolves an `{{ inputs.x }}` delay at dispatch", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({ home, clock, executor: new FakeExecutor() });
    try {
      const start = clock.now();
      await host.startRun({
        ir: delayPlaybook("{{ inputs.interval }}", { interval: { type: "string", required: false } }),
        inputs: { interval: "2m" },
        cwd: home,
      });
      await drive(clock, async () => (await delayCheckpoint(host))?.phase === "wait", { stepMs: 0 });
      const armed = await delayCheckpoint(host);
      expect(armed?.phase === "wait" ? armed.until : undefined).toBe(start + 2 * MINUTE);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("fails the step with step_failed when the template does not resolve", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({ home, clock, executor: new FakeExecutor() });
    try {
      const { runId } = await host.startRun({
        ir: delayPlaybook("{{ inputs.interval }}", { interval: { type: "string", required: false } }),
        inputs: { interval: "whenever" },
        cwd: home,
      });
      await drive(clock, async () => (await statusOf(host, runId)) !== "running", { stepMs: 0 });
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.steps["wait"]?.errorCode).toBe("step_failed");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("cancels a run that is paused in a delay", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({ home, clock, executor: new FakeExecutor() });
    try {
      const { runId } = await host.startRun({ ir: delayPlaybook("30m"), inputs: {}, cwd: home });
      await drive(clock, async () => (await delayCheckpoint(host))?.phase === "wait", { stepMs: 0 });
      await host.cancelRun(runId);
      await drive(clock, async () => (await statusOf(host, runId)) === "cancelled", { stepMs: 0 });
      expect(await delayCheckpoint(host)).toBeUndefined();
    } finally {
      await host.close();
      cleanup();
    }
  });
});
