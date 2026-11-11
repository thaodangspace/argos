import { describe, expect, it } from "vitest";

import { next } from "./reducer.js";
import type { EngineEvent } from "./reducer.js";
import type { RunRecord } from "./record.js";
import { goto, makeRecord, playbook, step } from "./test-util.js";

function apply(record: RunRecord, event: EngineEvent): { record: RunRecord; effects: ReturnType<typeof next>["effects"] } {
  return next(record, event);
}

function dispatch(record: RunRecord, now: number): RunRecord {
  return apply(record, { type: "tick", now }).record;
}

describe("transition table", () => {
  const chain = playbook({
    steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] })],
  });

  it("complete: marks the step done, records outputs, and dispatches dependents", () => {
    let record = dispatch(makeRecord(chain, { now: 1_000 }), 1_000);
    expect(record.steps["a"]?.status).toBe("running");

    const settled = apply(record, {
      type: "stepSettled",
      stepId: "a",
      outcome: "success",
      outputs: { plan: "do it" },
      endedAt: 1_100,
    });
    record = settled.record;

    expect(record.steps["a"]).toMatchObject({
      status: "completed",
      outputs: { plan: "do it" },
      outcome: "success",
    });
    expect(record.steps["a"]?.attempts).toEqual([
      {
        n: 1,
        requestId: "argos:run-1:a:1",
        startedAt: 1_000,
        endedAt: 1_100,
        outcome: "completed",
      },
    ]);
    expect(record.steps["b"]?.status).toBe("running");
    expect(settled.effects).toEqual([
      { type: "dispatchStep", stepId: "b", attempt: 1, requestId: "argos:run-1:b:1" },
    ]);
    expect(record.status).toBe("running");
    expect(record.seq).toBe(2);
  });

  it("complete: an undeclared outcome on a step with no on handler is a plain complete", () => {
    let record = dispatch(makeRecord(chain, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "a", outcome: "failure", endedAt: 1_100 }).record;
    expect(record.steps["a"]?.status).toBe("completed");
    expect(record.steps["a"]?.outcome).toBe("failure");
    expect(record.status).toBe("running");
  });

  it("end: completes the run with the named outcome and leaves unneeded steps pending", () => {
    const ir = playbook({
      steps: [
        step({ id: "a", on: { success: { kind: "end", outcome: "done" } } }),
        step({ id: "b", needs: ["a"] }),
      ],
    });
    let record = dispatch(makeRecord(ir, { now: 1_000 }), 1_000);
    const settled = apply(record, { type: "stepSettled", stepId: "a", outcome: "success", endedAt: 1_100 });
    record = settled.record;

    expect(record.status).toBe("completed");
    expect(record.outcome).toBe("done");
    expect(record.steps["a"]?.status).toBe("completed");
    expect(record.steps["b"]?.status).toBe("pending");
    expect(settled.effects).toContainEqual({ type: "finishRun", status: "completed", outcome: "done" });
  });

  it("end: a bare end records no outcome", () => {
    const ir = playbook({ steps: [step({ id: "a", on: { success: { kind: "end" } } })] });
    let record = dispatch(makeRecord(ir, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "a", outcome: "success", endedAt: 1_100 }).record;
    expect(record.status).toBe("completed");
    expect(record.outcome).toBeUndefined();
  });

  it("fail: fails the step and the run", () => {
    const ir = playbook({
      steps: [step({ id: "a", on: { failure: { kind: "fail" } } })],
    });
    let record = dispatch(makeRecord(ir, { now: 1_000 }), 1_000);
    const settled = apply(record, { type: "stepSettled", stepId: "a", outcome: "failure", endedAt: 1_100 });
    record = settled.record;

    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.errorCode).toBe("step_failed");
    expect(record.status).toBe("failed");
    expect(record.errorCode).toBe("step_failed");
    expect(settled.effects).toContainEqual({ type: "finishRun", status: "failed", errorCode: "step_failed" });
  });

  it("goto: records the edge, bumps loops, re-queues the target and passes feedback", () => {
    const ir = playbook({
      steps: [
        step({ id: "fix", on: { success: { kind: "complete" } } }),
        step({
          id: "review",
          needs: ["fix"],
          outcomes: ["approved", "changes_requested"],
          on: { changes_requested: goto("fix", 2) },
        }),
      ],
    });
    let record = dispatch(makeRecord(ir, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "fix", outcome: "success", endedAt: 1_100 }).record;
    const settled = apply(record, {
      type: "stepSettled",
      stepId: "review",
      outcome: "changes_requested",
      feedback: "please fix the parser",
      endedAt: 1_200,
    });
    record = settled.record;

    expect(record.loops).toEqual({ "review->fix": 1 });
    expect(record.steps["fix"]).toMatchObject({
      status: "running",
      feedback: "please fix the parser",
      loop: 1,
    });
    expect(record.steps["fix"]?.attempts).toHaveLength(2);
    expect(record.steps["review"]).toMatchObject({ status: "pending", loop: 1 });
    expect(record.steps["review"]?.outcome).toBeUndefined();
    expect(settled.effects).toContainEqual({
      type: "dispatchStep",
      stepId: "fix",
      attempt: 2,
      requestId: "argos:run-1:fix:2",
    });
  });

  it("unknown outcome at runtime fails the step with step_failed", () => {
    let record = dispatch(makeRecord(chain, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "a", outcome: "nonsense", endedAt: 1_100 }).record;
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.errorCode).toBe("step_failed");
    expect(record.status).toBe("failed");
  });

  it("an executor error code fails the step without merging outputs", () => {
    let record = dispatch(makeRecord(chain, { now: 1_000 }), 1_000);
    const settled = apply(record, {
      type: "stepSettled",
      stepId: "a",
      errorCode: "invalid_output",
      outputs: { garbage: "nope" },
      endedAt: 1_100,
    });
    record = settled.record;
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.errorCode).toBe("invalid_output");
    expect(record.steps["a"]?.outputs).toEqual({});
    expect(record.errorCode).toBe("invalid_output");
    expect(record.status).toBe("failed");
  });

  it("a duplicate settle after the step moved on is a no-op", () => {
    let record = dispatch(makeRecord(chain, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "a", outcome: "success", endedAt: 1_100 }).record;
    const before = record;
    const duplicate = apply(record, { type: "stepSettled", stepId: "a", outcome: "success", endedAt: 1_150 });
    expect(duplicate.record).toEqual(before);
    expect(duplicate.effects).toEqual([]);
  });
});

describe("ask transitions", () => {
  const asking = playbook({
    steps: [
      step({ id: "fix", on: { success: { kind: "complete" } } }),
      step({
        id: "review",
        needs: ["fix"],
        outcomes: ["changes_requested", "approved"],
        on: {
          changes_requested: {
            kind: "ask",
            ask: "How should the fix proceed?",
            target: "fix",
            maxLoops: 1,
            choices: {
              retry: { label: "Retry", comment: "required" },
              give_up: { label: "Give up", comment: "none", outcome: "approved" },
            },
          },
        },
      }),
    ],
  });

  function atGate(): RunRecord {
    let record = dispatch(makeRecord(asking, { now: 1_000 }), 1_000);
    record = apply(record, { type: "stepSettled", stepId: "fix", outcome: "success", endedAt: 1_100 }).record;
    return apply(record, { type: "stepSettled", stepId: "review", outcome: "changes_requested", endedAt: 1_200 }).record;
  }

  it("opens an ask gate with the question and choices, and waits", () => {
    const record = atGate();
    expect(record.status).toBe("waiting");
    expect(record.steps["review"]?.status).toBe("waiting");
    expect(record.gates[0]).toMatchObject({
      id: "review:1",
      kind: "ask",
      stepId: "review",
      question: "How should the fix proceed?",
      target: "fix",
      maxLoops: 1,
      status: "pending",
    });
    expect(Object.keys(record.gates[0]?.choices ?? {})).toEqual(["retry", "give_up"]);
  });

  it("a plain choice goes to the ask target with the comment as feedback", () => {
    const record = atGate();
    const decided = apply(record, {
      type: "gateDecided",
      gateId: "review:1",
      decision: "retry",
      comment: "try the other parser",
      decidedAt: 1_300,
    });
    expect(decided.record.steps["fix"]?.feedback).toContain("try the other parser");
    expect(decided.record.steps["fix"]?.status).toBe("running");
    expect(decided.effects).toContainEqual({
      type: "dispatchStep",
      stepId: "fix",
      attempt: 2,
      requestId: "argos:run-1:fix:2",
    });
  });

  it("a choice with an outcome re-routes through the step's transition table", () => {
    const record = atGate();
    const decided = apply(record, {
      type: "gateDecided",
      gateId: "review:1",
      decision: "give_up",
      decidedAt: 1_300,
    });
    expect(decided.record.steps["review"]?.status).toBe("completed");
    expect(decided.record.steps["review"]?.outcome).toBe("approved");
    expect(decided.record.status).toBe("completed");
    expect(decided.effects).toContainEqual({ type: "finishRun", status: "completed" });
  });
});
