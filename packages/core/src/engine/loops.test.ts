import { describe, expect, it } from "vitest";

import { canTraverse, edgeKey, loopGateId, loopUsage, parseEdgeKey } from "./loops.js";
import { next } from "./reducer.js";
import type { EngineEvent, NextResult } from "./reducer.js";
import type { RunRecord } from "./record.js";
import { goto, makeRecord, playbook, step } from "./test-util.js";

const loopPlaybook = playbook({
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

interface Drive {
  readonly record: RunRecord;
  readonly results: readonly NextResult[];
  readonly now: number;
}

function drive(record: RunRecord, events: readonly EngineEvent[], now = 1_000): Drive {
  const results: NextResult[] = [];
  let current = record;
  let clock = now;
  for (const event of events) {
    clock += 10;
    const stamped =
      event.type === "tick" || event.type === "cancel"
        ? { ...event, now: clock }
        : event.type === "stepSettled"
          ? { ...event, endedAt: clock }
          : event.type === "gateDecided"
            ? { ...event, decidedAt: clock, now: clock }
            : { ...event, startedAt: clock };
    const result = next(current, stamped);
    results.push(result);
    current = result.record;
  }
  return { record: current, results, now: clock };
}

function last(result: Drive): NextResult {
  const value = result.results[result.results.length - 1];
  if (value === undefined) throw new Error("no events");
  return value;
}

/** fix/review cycles: each pair settles fix successfully then review with changes_requested. */
function cycles(count: number): EngineEvent[] {
  const events: EngineEvent[] = [{ type: "tick", now: 0 }];
  for (let index = 0; index < count; index += 1) {
    events.push({ type: "stepSettled", stepId: "fix", outcome: "success", endedAt: 0 });
    events.push({ type: "stepSettled", stepId: "review", outcome: "changes_requested", endedAt: 0 });
  }
  return events;
}

describe("max_loops (FR15)", () => {
  it("allows exactly two returns, then opens a loop-limit gate on the third", () => {
    const driven = drive(makeRecord(loopPlaybook), cycles(3));
    const record = driven.record;

    expect(record.loops).toEqual({ "review->fix": 2 });
    expect(record.status).toBe("waiting");
    expect(record.steps["review"]?.status).toBe("waiting");
    expect(record.gates).toHaveLength(1);
    expect(record.gates[0]).toMatchObject({
      id: "review:1",
      kind: "loop_limit",
      stepId: "review",
      edge: "review->fix",
      target: "fix",
      maxLoops: 2,
      status: "pending",
    });
    expect(last(driven).effects).toContainEqual(
      expect.objectContaining({ type: "openGate", gateId: "review:1", kind: "loop_limit", stepId: "review" }),
    );
  });

  it("approval grants exactly one more traversal and the next limit is a new gate id", () => {
    const first = drive(makeRecord(loopPlaybook), cycles(3));
    const approved = drive(first.record, [
      {
        type: "gateDecided",
        gateId: "review:1",
        decision: "approve",
        comment: "one more try",
        decidedAt: 0,
        now: 0,
      },
    ]);

    expect(approved.record.loopAllowance).toEqual({ "review->fix": 1 });
    expect(approved.record.loops).toEqual({ "review->fix": 3 });
    expect(approved.record.steps["fix"]?.feedback).toContain("one more try");
    expect(approved.record.status).toBe("running");
    expect(last(approved).effects).toContainEqual(
      expect.objectContaining({ type: "dispatchStep", stepId: "fix", attempt: 4 }),
    );

    const second = drive(approved.record, [
      { type: "stepSettled", stepId: "fix", outcome: "success", endedAt: 0 },
      { type: "stepSettled", stepId: "review", outcome: "changes_requested", endedAt: 0 },
    ]);
    expect(second.record.loops).toEqual({ "review->fix": 3 });
    expect(second.record.gates.map((gate) => gate.id)).toEqual(["review:1", "review:2"]);
    expect(second.record.status).toBe("waiting");
  });

  it("rejection fails the step as step_failed", () => {
    const first = drive(makeRecord(loopPlaybook), cycles(3));
    const rejected = drive(first.record, [
      { type: "gateDecided", gateId: "review:1", decision: "reject", decidedAt: 0, now: 0 },
    ]);
    expect(rejected.record.steps["review"]?.status).toBe("failed");
    expect(rejected.record.steps["review"]?.errorCode).toBe("step_failed");
    expect(rejected.record.status).toBe("failed");
    expect(last(rejected).effects).toContainEqual(
      expect.objectContaining({ type: "finishRun", status: "failed" }),
    );
  });

  it("a duplicate decision is rejected and the first decision wins", () => {
    const first = drive(makeRecord(loopPlaybook), cycles(3));
    const approved = drive(first.record, [
      { type: "gateDecided", gateId: "review:1", decision: "approve", decidedAt: 0, now: 0 },
      { type: "gateDecided", gateId: "review:1", decision: "reject", decidedAt: 0, now: 0 },
    ]);
    expect(approved.record.gates[0]?.decision).toBe("approve");
    expect(last(approved).effects).toContainEqual({
      type: "decisionRejected",
      gateId: "review:1",
      code: "gate_already_decided",
    });
    expect(approved.record.status).not.toBe("failed");
  });

  it("an unknown gate id is rejected without touching the record", () => {
    const started = drive(makeRecord(loopPlaybook), [{ type: "tick", now: 0 }]);
    const record = started.record;
    const result = next(record, {
      type: "gateDecided",
      gateId: "ghost:1",
      decision: "approve",
      decidedAt: 1_000,
      now: 1_000,
    });
    expect(result.effects).toEqual([
      { type: "decisionRejected", gateId: "ghost:1", code: "gate_unknown" },
    ]);
    expect(result.record.seq).toBe(record.seq);
  });

  it("max_loops absent means unlimited: no gate is ever opened", () => {
    const ir = playbook({
      steps: [
        step({ id: "fix", on: { success: { kind: "complete" } } }),
        step({
          id: "review",
          needs: ["fix"],
          outcomes: ["approved", "changes_requested"],
          on: { changes_requested: goto("fix") },
        }),
      ],
    });
    const driven = drive(makeRecord(ir), cycles(5));
    expect(driven.record.loops).toEqual({ "review->fix": 5 });
    expect(driven.record.gates).toEqual([]);
    expect(driven.record.status).not.toBe("waiting");
  });
});

describe("loop helpers", () => {
  it("uses `<source>-><target>` edge labels with no spaces", () => {
    expect(edgeKey("fix", "review")).toBe("fix->review");
    expect(parseEdgeKey("fix->review")).toEqual({ source: "fix", target: "review" });
    expect(parseEdgeKey("nonsense")).toBeUndefined();
  });

  it("counts traversals and allowance", () => {
    const usage = loopUsage({ loops: { "a->b": 2 }, loopAllowance: {} }, "a->b", 2);
    expect(usage).toMatchObject({ loops: 2, allowance: 0, maxLoops: 2, remaining: 0 });
    expect(canTraverse({ loops: { "a->b": 2 }, loopAllowance: {} }, "a->b", 2)).toBe(false);
    expect(canTraverse({ loops: { "a->b": 2 }, loopAllowance: { "a->b": 1 } }, "a->b", 2)).toBe(true);
    expect(canTraverse({ loops: { "a->b": 100 }, loopAllowance: {} }, "a->b", undefined)).toBe(true);
  });

  it("numbers gates per step", () => {
    expect(loopGateId({ gates: [] }, "review")).toBe("review:1");
    expect(
      loopGateId(
        { gates: [{ id: "review:1", stepId: "review" } as never] },
        "review",
      ),
    ).toBe("review:2");
  });
});
