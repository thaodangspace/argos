import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import type { StepCheckpoint } from "../../src/durable/tasks/step.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { diamondPlaybook, drive, flush, makeTempHome } from "./support.js";

/** Find the durable step task of one step id. */
async function stepTaskOf(
  host: ArgosHost,
  stepId: string,
): Promise<TaskRecord<unknown, StepCheckpoint, unknown> | undefined> {
  const inspection = await host.inspect();
  const task = inspection.tasks.find(
    (candidate) => candidate.record.kind === "argos.step" && (candidate.record.input as { stepId: string }).stepId === stepId,
  );
  return task?.record as TaskRecord<unknown, StepCheckpoint, unknown> | undefined;
}

describe("durability (FR13/FR29)", () => {
  it("closes mid-run, reopens the same SQLite file, and launches every step exactly once", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor();
    const clock = new FakeClock();

    const first = await ArgosHost.open({ home, clock, executor });
    const { runId, taskId } = await first.startRun({
      ir: diamondPlaybook(),
      inputs: {},
      cwd: "/tmp/argos-durable",
    });

    // 1. `a` is launched and blocked in a status poll.
    await drive(clock, () => executor.creationsByStep()["a"] === 1, { stepMs: 1_000 });
    expect(executor.creations).toHaveLength(1);

    // 2. Complete `a`; `b` and `c` launch in parallel and block in their own polls.
    executor.completeAll();
    await drive(
      clock,
      () => executor.creationsByStep()["b"] === 1 && executor.creationsByStep()["c"] === 1,
      { stepMs: 1_000 },
    );
    // Let both step tasks commit `agentId` and park in the `await` sleep before we kill the host.
    await drive(
      clock,
      async () => {
        const b = await stepTaskOf(first, "b");
        const c = await stepTaskOf(first, "c");
        return b?.state.status === "sleeping" && c?.state.status === "sleeping";
      },
      { stepMs: 500, maxRounds: 10 },
    );

    const bTask = await stepTaskOf(first, "b");
    const cTask = await stepTaskOf(first, "c");
    expect(bTask?.state.status).toBe("sleeping");
    expect(cTask?.state.status).toBe("sleeping");
    const launchesBeforeClose = executor.launchCalls.length;

    await first.close();

    // 3. Reopen the same file with the same fake (its in-memory agents model the daemon).
    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      await flush();
      // The step tasks resume at their committed `await` checkpoint: no second launch.
      expect(executor.launchCalls).toHaveLength(launchesBeforeClose);
      expect(executor.callsForStep("b")).toHaveLength(1);
      expect(executor.callsForStep("c")).toHaveLength(1);

      // 4. Finish the run across the new lifetime.
      await drive(
        clock2,
        async () => {
          executor.completeAll();
          const doc = await second.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 20 },
      );

      const doc = await second.getRun(runId);
      expect(doc?.record.status).toBe("completed");
      expect(executor.creationsByStep()).toEqual({ a: 1, b: 1, c: 1, d: 1 });
      expect([...new Set(executor.launchCalls)].sort()).toEqual(
        ["a", "b", "c", "d"].map((step) => `argos:${runId}:${step}:1`).sort(),
      );
      // One launch *decision* per step: no step was relaunched after the reopen.
      for (const step of ["a", "b", "c", "d"]) {
        expect(executor.callsForStep(step)).toHaveLength(1);
      }

      const task = (await second.getTaskRecord(taskId)) as TaskRecord<unknown, unknown, unknown>;
      const state = task.state as { status: string; outcome?: { status: string } };
      expect(state.status).toBe("terminal");
      expect(state.outcome?.status).toBe("completed");
    } finally {
      await second.close();
      cleanup();
    }
  });

  it("re-enters the launch phase after a crash and adopts the existing agent", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor();
    const clock = new FakeClock();
    const runId = "run-crash-window";
    const requestId = `argos:${runId}:a:1`;
    executor.blockLaunch(requestId);

    const first = await ArgosHost.open({ home, clock, executor });
    await first.startRun({
      ir: diamondPlaybook(),
      inputs: {},
      cwd: "/tmp/argos-crash-window",
      id: runId,
    });

    // The agent exists, but the launch call never returns (crash before the agentId commit).
    await drive(clock, () => executor.creations.includes(requestId), { stepMs: 1_000 });
    expect(executor.launchCalls.filter((id) => id === requestId)).toHaveLength(1);
    const before = await stepTaskOf(first, "a");
    expect(before?.state.status).toBe("running");
    expect((before?.state as { checkpoint?: StepCheckpoint }).checkpoint?.phase).toBe("launch");
    await first.close();

    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      executor.releaseLaunch(requestId);
      await flush();

      // The task re-runs `launch`, adopts agent-1, and does not create another agent.
      await drive(
        clock2,
        () => executor.launchCalls.filter((id) => id === requestId).length >= 2,
        { stepMs: 1_000 },
      );
      expect(executor.creationsByStep()["a"]).toBe(1);
      expect(executor.agents.size).toBe(1);
      expect(new Set(executor.launchCalls.filter((id) => id === requestId)).size).toBe(1);

      const after = await stepTaskOf(second, "a");
      expect((after?.state as { checkpoint?: StepCheckpoint }).checkpoint?.requestId).toBe(requestId);

      await drive(
        clock2,
        async () => {
          executor.completeAll();
          const doc = await second.getRun(runId);
          return doc?.record.status === "completed" || doc?.record.status === "failed";
        },
        { stepMs: 3_000, maxRounds: 20 },
      );
      expect((await second.getRun(runId))?.record.status).toBe("completed");
      expect(executor.creationsByStep()).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    } finally {
      await second.close();
      cleanup();
    }
  });
});
