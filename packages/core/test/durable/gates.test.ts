/**
 * Phase 5 gates (FR19, FR20, FR15) — the decision channel end to end.
 *
 * Every test drives the durable host with a fake clock: the gate task's 2 s poll is a `sleeping`
 * state, never a real timer, so a test advances time explicitly instead of waiting.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage, type TaskInspection } from "@earendil-works/pi-durable";

import { GATE_POLL_MS } from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import { hydrateRunCheckpoint } from "../../src/durable/tasks/run.js";
import { isArgosError } from "../../src/errors.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { drive, flush, gatedPlaybook, loopPlaybook, makeTempHome } from "./support.js";

/** The live `argos.gate` task of one gate id, as `inspect()` reports it. */
async function gateTask(host: ArgosHost, gateId: string): Promise<TaskInspection | undefined> {
  const inspection = await host.inspect();
  return inspection.tasks.find(
    (candidate) =>
      candidate.record.kind === "argos.gate" &&
      (candidate.record.input as { gateId?: string }).gateId === gateId,
  );
}

/** Advance the clock until the gate task is parked in its D7 sleep. */
async function waitForSleepingGate(host: ArgosHost, clock: FakeClock, gateId: string): Promise<void> {
  await drive(clock, async () => (await gateTask(host, gateId))?.state.kind === "sleeping");
  await flush();
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

describe("gates: opening (FR19)", () => {
  it("opens one sleeping argos.gate task inside the 2 s poll budget, with a pending document", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId, taskId } = await host.startRun({
        ir: gatedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-gate-open",
        id: "run-gate-open",
      });
      await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1);

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("waiting");
      const gate = record?.gates[0];
      expect(gate?.id).toBe("review:1");
      expect(gate?.kind).toBe("step");
      expect(gate?.status).toBe("pending");
      expect(record?.steps["review"]?.status).toBe("waiting");

      // The decision document is the channel the CLI/plugin will read and write.
      const document = await host.getGate(runId, "review:1");
      expect(document?.status).toBe("pending");
      expect(document?.question).toBe("Ship it?");
      expect(Object.keys(document?.choices ?? {})).toEqual(["approve", "revise"]);
      expect(document?.runId).toBe(runId);
      expect(document?.stepId).toBe("review");

      // FR19/D7: the gate is a live `sleeping` task due at most one poll from now.
      await waitForSleepingGate(host, clock, "review:1");
      const task = await gateTask(host, "review:1");
      expect(task?.state.kind).toBe("sleeping");
      if (task?.state.kind === "sleeping") {
        expect(task.state.until).toBeGreaterThan(clock.now());
        expect(task.state.until).toBeLessThanOrEqual(clock.now() + GATE_POLL_MS);
      }
      // One gate task, owned by the run task (D5).
      expect((task?.record.owner === undefined ? 0 : 1)).toBe(1);

      // The Phase 5 checkpoint (gateTasks/gateSettles/afterTasks) still round-trips byte for byte
      // and still equals the mirror.
      const live = await host.getTaskRecord(taskId);
      const state = live?.state as { checkpoint?: unknown } | undefined;
      expect(state?.checkpoint).toBeDefined();
      const json = JSON.stringify(state?.checkpoint);
      expect(JSON.stringify(hydrateRunCheckpoint(json))).toBe(json);
      expect(JSON.stringify(hydrateRunCheckpoint(json).record)).toBe(
        JSON.stringify((await host.getRun(runId))?.record),
      );
    } finally {
      await host.close();
    }
  });
});

describe("gates: decisions (FR19)", () => {
  it("writes a decision once; a duplicate fails with gate_already_decided and the first wins", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: gatedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-gate-decide",
        id: "run-gate-decide",
      });
      await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1);

      const receipt = await host.decideGate(runId, "review:1", "approve", {
        comment: "looks good",
        decidedBy: "dt",
        decidedVia: "rpc",
      });
      expect(receipt).toMatchObject({
        runId,
        gateId: "review:1",
        decision: "approve",
        comment: "looks good",
        decidedBy: "dt",
        decidedVia: "rpc",
      });

      const document = await host.getGate(runId, "review:1");
      expect(document?.status).toBe("decided");
      expect(document?.decision).toBe("approve");
      expect(document?.comment).toBe("looks good");
      expect(document?.decidedBy).toBe("dt");

      // Second decision: rejected, and the message names the winning decision.
      const duplicate = await errorOf(host.decideGate(runId, "review:1", "revise"));
      expect(isArgosError(duplicate)).toBe(true);
      if (isArgosError(duplicate)) {
        expect(duplicate.code).toBe("gate_already_decided");
        expect(duplicate.message).toContain("approve");
      }
      // The document still holds the first decision.
      expect((await host.getGate(runId, "review:1"))?.decision).toBe("approve");

      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 1_000, maxRounds: 20 },
      );
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.outcome).toBe("approved");
      const gate = record?.gates[0];
      expect(gate?.status).toBe("decided");
      expect(gate?.decision).toBe("approve");
      expect(gate?.comment).toBe("looks good");
      expect(gate?.decidedBy).toBe("dt");
      expect(gate?.decidedVia).toBe("rpc");
      expect(record?.steps["review"]?.status).toBe("completed");
      expect(record?.steps["review"]?.outcome).toBe("approve");
      expect((await host.getHistory(runId))?.events.some((event) => event.type === "gate_decided")).toBe(true);
      // The gate task is terminal and gone from the live graph.
      expect(await gateTask(host, "review:1")).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  it("rejects unknown gates, unknown runs, and out-of-choice decisions with gate_unknown", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: gatedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-gate-unknown",
        id: "run-gate-unknown",
      });
      await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1);

      const unknownGate = await errorOf(host.decideGate(runId, "review:9", "approve"));
      expect(isArgosError(unknownGate) && unknownGate.code).toBe("gate_unknown");

      const unknownRun = await errorOf(host.decideGate("run-nope", "review:1", "approve"));
      expect(isArgosError(unknownRun) && unknownRun.code).toBe("gate_unknown");

      const badChoice = await errorOf(host.decideGate(runId, "review:1", "maybe"));
      expect(isArgosError(badChoice) && badChoice.code).toBe("gate_unknown");
      if (isArgosError(badChoice)) expect(badChoice.message).toContain("approve, revise");

      // A rejected decision never wrote the document, so the gate is still open.
      expect((await host.getGate(runId, "review:1"))?.status).toBe("pending");
      expect((await host.getRun(runId))?.record.gates[0]?.status).toBe("pending");

      // And a valid decision still works afterwards.
      await host.decideGate(runId, "review:1", "revise", { comment: "not yet" });
      expect((await host.getGate(runId, "review:1"))?.decision).toBe("revise");
    } finally {
      await host.close();
    }
  });

  it("keeps a pending gate across a close/reopen and accepts the decision afterwards", async () => {
    const { home, cleanup } = makeTempHome();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const clock = new FakeClock();
    const first = await ArgosHost.open({ home, clock, executor });
    const { runId } = await first.startRun({
      ir: gatedPlaybook(),
      inputs: {},
      cwd: "/tmp/argos-gate-reopen",
      id: "run-gate-reopen",
    });
    await drive(clock, async () => ((await first.getRun(runId))?.record.gates.length ?? 0) === 1);
    const beforeGate = await first.getGate(runId, "review:1");
    const beforeTask = await gateTask(first, "review:1");
    expect(beforeGate?.status).toBe("pending");
    await first.close();

    const clock2 = new FakeClock(clock.now());
    const second = await ArgosHost.open({ home, clock: clock2, executor });
    try {
      // Same gate id, still pending, same task (still sleeping on the D7 poll).
      const afterGate = await second.getGate(runId, "review:1");
      expect(afterGate?.status).toBe("pending");
      expect(afterGate?.createdAt).toBe(beforeGate?.createdAt);
      expect(afterGate?.gateId).toBe("review:1");
      const record = (await second.getRun(runId))?.record;
      expect(record?.status).toBe("waiting");
      expect(record?.gates.map((gate) => gate.id)).toEqual(["review:1"]);
      expect(record?.gates[0]?.status).toBe("pending");

      await waitForSleepingGate(second, clock2, "review:1");
      expect((await gateTask(second, "review:1"))?.record.id).toBe(beforeTask?.record.id);

      // The decision is accepted after the reopen and the run finishes.
      await second.decideGate(runId, "review:1", "approve", { comment: "after restart" });
      await drive(
        clock2,
        async () => (await second.getRun(runId))?.record.status === "completed",
        { stepMs: 1_000, maxRounds: 20 },
      );
      const finished = (await second.getRun(runId))?.record;
      expect(finished?.status).toBe("completed");
      expect(finished?.outcome).toBe("approved");
      expect(finished?.gates[0]?.comment).toBe("after restart");
    } finally {
      await second.close();
      cleanup();
    }
  });
});

describe("gates: ask decisions and recovery", () => {
  it("routes an ask gate decision and forwards the comment as feedback", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) => ({ outcome: agent.stepId === "implement" ? "escalate" : "success" }),
    });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const ir = playbook({
        id: "ask-gate",
        steps: [
          step({
            id: "implement",
            outcomes: ["done", "escalate"],
            on: {
              done: { kind: "complete" },
              escalate: {
                kind: "ask",
                ask: "Which way?",
                target: "fix",
                choices: {
                  rewrite: { label: "Rewrite the fix", comment: "required", goto: "fix" },
                  skip: { label: "Skip it", comment: "optional", outcome: "done" },
                },
              },
            },
          }),
          step({ id: "fix", needs: ["implement"], prompt: "Fix it.\nFeedback: {{ feedback }}" }),
        ],
      });
      const { runId } = await host.startRun({
        ir,
        inputs: {},
        cwd: "/tmp/argos-gate-ask",
        id: "run-gate-ask",
      });
      await drive(
        clock,
        async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1,
        { stepMs: 3_000, maxRounds: 20 },
      );

      const opened = (await host.getRun(runId))?.record;
      const gate = opened?.gates[0];
      expect(gate?.id).toBe("implement:1");
      expect(gate?.kind).toBe("ask");
      expect(gate?.question).toBe("Which way?");
      expect(Object.keys(gate?.choices ?? {})).toEqual(["rewrite", "skip"]);
      expect((await host.getGate(runId, "implement:1"))?.kind).toBe("ask");

      await host.decideGate(runId, "implement:1", "rewrite", { comment: "do it properly" });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 3_000, maxRounds: 30 },
      );

      const finished = (await host.getRun(runId))?.record;
      expect(finished?.status).toBe("completed");
      expect(finished?.steps["fix"]?.status).toBe("completed");
      // The ask choice's `goto` routed to `fix`, with the decision comment as feedback.
      const fixAgent = executor.agentForStep("fix");
      expect(fixAgent.feedback).toContain("do it properly");
      expect(fixAgent.prompt).toContain("do it properly");
    } finally {
      await host.close();
    }
  });

  it("re-opens a pending gate whose child broke, keeping the gate id and the document", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: gatedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-gate-recover",
        id: "run-gate-recover",
      });
      await drive(clock, async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1);
      const first = await gateTask(host, "review:1");
      expect(first).toBeDefined();
      const firstTaskId = first?.record.id as number;

      // Abort the gate child: the run sees a non-completed outcome and must re-open the same gate.
      await host.harness.abortTask(firstTaskId as never, host.context);
      await drive(clock, async () => {
        const reopened = await gateTask(host, "review:1");
        return (
          reopened !== undefined &&
          reopened.record.id !== firstTaskId &&
          reopened.state.kind === "sleeping"
        );
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("waiting");
      expect(record?.gates.map((gate) => gate.id)).toEqual(["review:1"]);
      expect(record?.gates[0]?.status).toBe("pending");
      expect((await host.getGate(runId, "review:1"))?.status).toBe("pending");

      // The gate still accepts exactly one decision.
      await host.decideGate(runId, "review:1", "approve");
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 1_000, maxRounds: 20 },
      );
      expect((await host.getRun(runId))?.record.outcome).toBe("approved");
    } finally {
      await host.close();
    }
  });
});

describe("gates: loop limit (FR15)", () => {  it("approve grants exactly one more traversal and the edge fires again", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) =>
        agent.stepId === "review"
          ? { outcome: agent.attempt >= 3 ? "approve" : "changes" }
          : { outcome: "success" },
    });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: loopPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-loop-approve",
        id: "run-loop-approve",
      });
      await drive(
        clock,
        async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1,
        { stepMs: 3_000, maxRounds: 30 },
      );

      const opened = (await host.getRun(runId))?.record;
      expect(opened?.status).toBe("waiting");
      const gate = opened?.gates[0];
      expect(gate?.id).toBe("review:1");
      expect(gate?.kind).toBe("loop_limit");
      expect(gate?.edge).toBe("review->fix");
      expect(opened?.loops["review->fix"]).toBe(1);
      expect(opened?.loopAllowance["review->fix"]).toBeUndefined();
      expect(gate?.choices["approve"]?.label).toBeTruthy();
      expect(gate?.choices["reject"]?.label).toBeTruthy();

      await host.decideGate(runId, "review:1", "approve", { comment: "one more pass" });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "completed",
        { stepMs: 3_000, maxRounds: 40 },
      );

      const finished = (await host.getRun(runId))?.record;
      expect(finished?.status).toBe("completed");
      expect(finished?.outcome).toBe("approved");
      // Exactly one extra allowance, and the edge traversed a second time.
      expect(finished?.loopAllowance["review->fix"]).toBe(1);
      expect(finished?.loops["review->fix"]).toBe(2);
      expect(executor.agentsForStep("fix").map((agent) => agent.attempt)).toEqual([1, 2, 3]);
      // The approval comment reached the re-queued step as feedback (FR15).
      expect(executor.latestAgentForStep("fix")?.feedback).toContain("one more pass");
    } finally {
      await host.close();
    }
  });

  it("reject terminates the step as step_failed", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) =>
        agent.stepId === "review" ? { outcome: "changes" } : { outcome: "success" },
    });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: loopPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-loop-reject",
        id: "run-loop-reject",
      });
      await drive(
        clock,
        async () => ((await host.getRun(runId))?.record.gates.length ?? 0) === 1,
        { stepMs: 3_000, maxRounds: 30 },
      );
      await host.decideGate(runId, "review:1", "reject", { comment: "stop here" });
      await drive(
        clock,
        async () => (await host.getRun(runId))?.record.status === "failed",
        { stepMs: 1_000, maxRounds: 20 },
      );

      const finished = (await host.getRun(runId))?.record;
      expect(finished?.status).toBe("failed");
      expect(finished?.errorCode).toBe("step_failed");
      expect(finished?.steps["review"]?.status).toBe("failed");
      expect(finished?.steps["review"]?.errorCode).toBe("step_failed");
      expect(finished?.loopAllowance["review->fix"]).toBeUndefined();
      expect(finished?.loops["review->fix"]).toBe(1);
    } finally {
      await host.close();
    }
  });
});

describe("gates: feedback (FR15)", () => {
  it("renders the gate comment into the next attempt's feedback and prompt", async () => {
    const clock = new FakeClock();
    const executor = new FakeExecutor({ complete: () => ({ outcome: "success" }) });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), clock, executor });
    try {
      const { runId } = await host.startRun({
        ir: gatedPlaybook(),
        inputs: {},
        cwd: "/tmp/argos-gate-feedback",
        id: "run-gate-feedback",
      });
      await drive(
        clock,
        async () => (await executor.agentsForStep("draft").length) === 1 &&
          ((await host.getRun(runId))?.record.gates.length ?? 0) === 1,
        { stepMs: 3_000, maxRounds: 20 },
      );

      await host.decideGate(runId, "review:1", "revise", { comment: "rename the flag" });
      await drive(
        clock,
        async () => (await executor.agentsForStep("draft").length) === 2,
        { stepMs: 3_000, maxRounds: 30 },
      );

      const second = executor.agentsForStep("draft")[1];
      expect(second?.feedback).toContain("rename the flag");
      expect(second?.feedback).toContain("review:1");
      expect(second?.prompt).toContain("rename the flag");
      // The template placeholder was rendered, not passed through.
      expect(second?.prompt).not.toContain("{{ feedback }}");

      // The re-run draft is the second attempt of the same step, with a fresh request id.
      expect(second?.attempt).toBe(2);
      expect(second?.requestId).toBe(`argos:${runId}:draft:2`);
      const record = (await host.getRun(runId))?.record;
      expect(record?.gates[0]?.status).toBe("decided");
      expect(record?.gates[0]?.comment).toBe("rename the flag");
      expect(record?.steps["draft"]?.loop).toBe(1);
    } finally {
      await host.close();
    }
  });
});
