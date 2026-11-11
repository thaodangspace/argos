/**
 * Phase 5 after-tasks (FR11).
 *
 * An `after` entry runs as its own `argos.run` child task: `auto` starts in the parent's `done`
 * phase, `manual` waits for `ArgosHost.startAfterTask`. Neither ever changes the parent's
 * `run.status`; only the host-owned `after[id]` bookkeeping moves.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage, type TaskRecord } from "@earendil-works/pi-durable";

import { ArgosHost } from "../../src/durable/host.js";
import { isArgosError } from "../../src/errors.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { afterPlaybook, drive, singleStepPlaybook } from "./support.js";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

describe("after-tasks (FR11)", () => {
  it("runs an auto after-task only once the main graph is terminal, without changing run.status", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId, taskId } = await host.startRun({
        ir: afterPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-after-auto",
        id: "run-after-auto",
      });

      // Before the main step settles nothing after-related has started.
      await drive(clock, () => executor.agents.size >= 1);
      expect(executor.agentsForStep("report-step")).toHaveLength(0);
      expect(executor.agentsForStep("cleanup-step")).toHaveLength(0);
      const before = (await host.getRun(runId))?.record;
      expect(before?.status).toBe("running");
      expect(before?.after).toEqual({
        report: { status: "pending" },
        cleanup: { status: "pending" },
      });

      // Finish the main graph: the reducer marks the auto after-task running and the `done` phase
      // creates its child run task (owned by the parent run task).
      executor.complete(`argos:${runId}:main:1`);
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");

      const completed = (await host.getRun(runId))?.record;
      expect(completed?.status).toBe("completed");
      expect(completed?.after).toEqual({
        report: { status: "running", startedAt: clock.now() },
        cleanup: { status: "pending" },
      });

      // The parent task is held in `completing` while its owned after-task is live.
      const parent = (await host.getTaskRecord(taskId)) as TaskRecord<unknown, unknown, unknown>;
      expect(parent.state.status).toBe("completing");

      // The auto after-task is its own run with its own scoped IR and its own step.
      await drive(clock, () => executor.agentsForStep("report-step").length === 1);
      const reportAgent = executor.agentForStep("report-step");
      expect(reportAgent.runId).not.toBe(runId);
      const reportRun = await host.getRun(reportAgent.runId);
      expect(reportRun?.record.playbookId).toBe("with-after/report");
      expect(Object.keys(reportRun?.record.steps ?? {})).toEqual(["report-step"]);
      // The parent's status is untouched by the after-task running.
      expect((await host.getRun(runId))?.record.status).toBe("completed");

      executor.complete(reportAgent.requestId);
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["report"]?.status === "completed",
        { stepMs: 3_000, maxRounds: 20 },
      );

      const afterAuto = (await host.getRun(runId))?.record;
      expect(afterAuto?.status).toBe("completed");
      expect(afterAuto?.after["report"]?.status).toBe("completed");
      expect(afterAuto?.after["report"]?.endedAt).toBeGreaterThan(0);
      // `manual` stays pending until the host API starts it.
      expect(afterAuto?.after["cleanup"]).toEqual({ status: "pending" });
      expect(executor.agentsForStep("cleanup-step")).toHaveLength(0);
      expect((await host.getRun(reportAgent.runId))?.record.status).toBe("completed");
    } finally {
      await host.close();
    }
  });

  it("starts a manual after-task through startAfterTask, once, after the run is terminal", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: afterPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-after-manual",
        id: "run-after-manual",
      });

      // Too early: the main graph is not terminal yet.
      const early = await errorOf(host.startAfterTask(runId, "cleanup"));
      expect(isArgosError(early)).toBe(true);
      if (isArgosError(early)) {
        expect(early.code).toBe("run_terminal");
        expect(early.message).toContain("after-tasks start once the main graph is terminal");
      }

      await drive(clock, () => executor.agents.size >= 1);
      executor.complete(`argos:${runId}:main:1`);
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["report"]?.status === "running",
      );
      // Let the auto after-task finish so the parent run task reaches its terminal receipt.
      await drive(clock, () => executor.agentsForStep("report-step").length === 1);
      executor.complete(executor.agentForStep("report-step").requestId);
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["report"]?.status === "completed",
        { stepMs: 3_000, maxRounds: 20 },
      );

      const started = await host.startAfterTask(runId, "cleanup");
      expect(started.started).toBe(true);
      expect(started.taskId).toBeDefined();

      // Idempotent: a second call does not start another child.
      const again = await host.startAfterTask(runId, "cleanup");
      expect(again.started).toBe(false);

      await drive(clock, () => executor.agentsForStep("cleanup-step").length === 1);
      const cleanupAgent = executor.agentForStep("cleanup-step");
      const cleanupRun = await host.getRun(cleanupAgent.runId);
      expect(cleanupRun?.record.playbookId).toBe("with-after/cleanup");
      expect((await host.getRun(runId))?.record.after["cleanup"]?.status).toBe("running");
      expect((await host.getRun(runId))?.record.status).toBe("completed");

      executor.complete(cleanupAgent.requestId);
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["cleanup"]?.status === "completed",
        { stepMs: 3_000, maxRounds: 20 },
      );
      const finished = (await host.getRun(runId))?.record;
      expect(finished?.status).toBe("completed");
      expect(finished?.after["cleanup"]?.status).toBe("completed");
      expect(finished?.after["report"]?.status).toBe("completed");

      const unknown = await errorOf(host.startAfterTask(runId, "nope"));
      expect(isArgosError(unknown) && unknown.code).toBe("playbook_missing");
      const unknownRun = await errorOf(host.startAfterTask("run-nope", "cleanup"));
      expect(isArgosError(unknownRun) && unknownRun.code).toBe("playbook_missing");
    } finally {
      await host.close();
    }
  });

  it("records a failed after-task as failed without failing the parent run", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: afterPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-after-failed",
        id: "run-after-failed",
      });
      await drive(clock, () => executor.agents.size >= 1);
      executor.complete(`argos:${runId}:main:1`);
      await drive(clock, () => executor.agentsForStep("report-step").length === 1);
      executor.complete(executor.agentForStep("report-step").requestId, {
        errorCode: "step_failed",
      });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.after["report"]?.status === "failed",
        { stepMs: 3_000, maxRounds: 20 },
      );

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.after["report"]?.status).toBe("failed");
      expect(record?.after["cleanup"]?.status).toBe("pending");
      const reportRun = await host.getRun(executor.agentForStep("report-step").runId);
      expect(reportRun?.record.status).toBe("failed");
      expect(reportRun?.record.steps["report-step"]?.errorCode).toBe("step_failed");
    } finally {
      await host.close();
    }
  });

  it("does not start an after-task for a playbook without one", async () => {    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: singleStepPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-after-none",
        id: "run-after-none",
      });
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      expect((await host.getRun(runId))?.record.after).toEqual({});
    } finally {
      await host.close();
    }
  });
});
