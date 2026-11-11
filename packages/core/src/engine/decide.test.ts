import { describe, expect, it } from "vitest";

import { decideGate } from "./decide.js";
import { next } from "./reducer.js";
import { goto, makeRecord, playbook, step } from "./test-util.js";
import type { RunRecord } from "./record.js";

/** A one-gate playbook: the only step is a human gate with `approve`/`reject`. */
function gatePlaybook() {
  return playbook({
    id: "decide-gate",
    steps: [
      step({
        id: "review",
        kind: "gate",
        outcomes: ["approve", "reject"],
        gate: {
          question: "Ship it?",
          choices: {
            approve: { label: "Approve", comment: "optional" },
            reject: { label: "Reject", comment: "required" },
          },
        },
        on: {
          approve: { kind: "end", outcome: "approved" },
          reject: { kind: "fail" },
        },
      }),
    ],
  });
}

/** `fix → review` with one allowed return, so a second `changes` opens a loop-limit gate. */
function loopPlaybook() {
  return playbook({
    id: "decide-loop",
    steps: [
      step({ id: "fix" }),
      step({
        id: "review",
        needs: ["fix"],
        outcomes: ["changes", "approve"],
        on: {
          changes: goto("fix", 1),
          approve: { kind: "end", outcome: "approved" },
        },
      }),
    ],
  });
}

/** Drive a record to its first open gate through the reducer only. */
function recordWithGate(ir: ReturnType<typeof gatePlaybook> | ReturnType<typeof loopPlaybook>): RunRecord {
  let record = next(makeRecord(ir), { type: "tick", now: 1_000 }).record;
  for (let round = 0; round < 8 && record.gates.length === 0; round += 1) {
    const pendingFix = record.steps["fix"]?.status === "running";
    if (pendingFix) {
      record = next(record, {
        type: "stepSettled",
        stepId: "fix",
        outcome: "success",
        endedAt: 1_100 + round,
      }).record;
      continue;
    }
    if (record.steps["review"]?.status === "running") {
      record = next(record, {
        type: "stepSettled",
        stepId: "review",
        outcome: ir.id === "decide-loop" ? "changes" : "approve",
        endedAt: 1_200 + round,
      }).record;
      continue;
    }
    record = next(record, { type: "tick", now: 1_300 + round }).record;
  }
  return record;
}

describe("decideGate (pure)", () => {
  it("applies an allowed decision through the reducer and ends the run", () => {
    const record = recordWithGate(gatePlaybook());
    expect(record.gates[0]?.id).toBe("review:1");
    expect(record.gates[0]?.status).toBe("pending");

    const plan = decideGate(record, {
      gateId: "review:1",
      decision: "approve",
      comment: "go",
      decidedBy: "dt",
      decidedVia: "test",
      decidedAt: 2_000,
    });

    expect(plan.rejection).toBeUndefined();
    expect(plan.gate?.id).toBe("review:1");
    expect(plan.record.status).toBe("completed");
    expect(plan.record.outcome).toBe("approved");
    expect(plan.record.gates[0]?.status).toBe("decided");
    expect(plan.record.gates[0]?.decision).toBe("approve");
    expect(plan.record.gates[0]?.comment).toBe("go");
    expect(plan.record.gates[0]?.decidedBy).toBe("dt");
    expect(plan.record.gates[0]?.decidedAt).toBe(2_000);
    expect(plan.effects.some((effect) => effect.type === "finishRun")).toBe(true);
    // The input record is untouched (frozen, never mutated in place).
    expect(record.gates[0]?.status).toBe("pending");
    expect(record.status).toBe("waiting");
  });

  it("computes exactly what the reducer computes for the same event", () => {
    const record = recordWithGate(gatePlaybook());
    const plan = decideGate(record, {
      gateId: "review:1",
      decision: "approve",
      decidedAt: 2_000,
    });
    const direct = next(record, {
      type: "gateDecided",
      gateId: "review:1",
      decision: "approve",
      decidedAt: 2_000,
    });
    expect(JSON.stringify(plan.record)).toBe(JSON.stringify(direct.record));
    expect(JSON.stringify(plan.effects)).toBe(JSON.stringify(direct.effects));
  });

  it("rejects unknown gate ids and out-of-choice decisions with gate_unknown", () => {
    const record = recordWithGate(gatePlaybook());

    const unknown = decideGate(record, { gateId: "review:9", decision: "approve", decidedAt: 2_000 });
    expect(unknown.rejection?.code).toBe("gate_unknown");
    expect(unknown.record).toBe(record);
    expect(unknown.effects).toEqual([
      { type: "decisionRejected", gateId: "review:9", code: "gate_unknown" },
    ]);

    const choice = decideGate(record, { gateId: "review:1", decision: "maybe", decidedAt: 2_000 });
    expect(choice.rejection?.code).toBe("gate_unknown");
    expect(choice.rejection?.message).toContain("approve");
    expect(choice.rejection?.message).toContain("reject");
    expect(choice.record).toBe(record);
  });

  it("rejects a second decision with gate_already_decided and names the winner", () => {
    const record = recordWithGate(gatePlaybook());
    const first = decideGate(record, {
      gateId: "review:1",
      decision: "reject",
      decidedAt: 2_000,
    });
    expect(first.record.status).toBe("failed");

    const second = decideGate(first.record, {
      gateId: "review:1",
      decision: "approve",
      decidedAt: 2_500,
    });
    // The run is already terminal, which the write path reports as `run_terminal`.
    expect(second.rejection?.code).toBe("run_terminal");

    // On a still-running record, the duplicate code is `gate_already_decided`.
    const rejectedGate = decideGate(record, {
      gateId: "review:1",
      decision: "approve",
      decidedAt: 2_000,
    });
    const loopRecord = recordWithGate(loopPlaybook());
    expect(loopRecord.status).toBe("waiting");
    const decided = decideGate(loopRecord, {
      gateId: "review:1",
      decision: "approve",
      decidedAt: 2_000,
    });
    expect(decided.rejection).toBeUndefined();
    const duplicate = decideGate(decided.record, {
      gateId: "review:1",
      decision: "reject",
      decidedAt: 2_100,
    });
    expect(duplicate.rejection?.code).toBe("gate_already_decided");
    expect(duplicate.rejection?.message).toContain('"approve"');
    expect(duplicate.record).toBe(decided.record);
    expect(rejectedGate.rejection).toBeUndefined();
  });

  it("grants exactly one loop allowance on an approved loop-limit gate", () => {
    const record = recordWithGate(loopPlaybook());
    const gate = record.gates[0];
    expect(gate?.kind).toBe("loop_limit");
    expect(gate?.id).toBe("review:1");
    expect(gate?.edge).toBe("review->fix");
    expect(record.loops["review->fix"]).toBe(1);
    expect(record.loopAllowance["review->fix"]).toBeUndefined();

    const plan = decideGate(record, {
      gateId: "review:1",
      decision: "approve",
      comment: "one more",
      decidedAt: 2_000,
    });
    expect(plan.rejection).toBeUndefined();
    expect(plan.record.loopAllowance["review->fix"]).toBe(1);
    expect(plan.record.loops["review->fix"]).toBe(2);
    expect(plan.record.steps["fix"]?.status).toBe("running");
    expect(plan.record.steps["review"]?.status).toBe("pending");
    // The comment is the feedback the re-queued step receives.
    expect(plan.record.steps["fix"]?.feedback).toContain("one more");
    expect(plan.effects.some((effect) => effect.type === "dispatchStep" && effect.stepId === "fix")).toBe(true);
  });

  it("fails the step on a rejected loop-limit gate", () => {
    const record = recordWithGate(loopPlaybook());
    const plan = decideGate(record, {
      gateId: "review:1",
      decision: "reject",
      decidedAt: 2_000,
    });
    expect(plan.rejection).toBeUndefined();
    expect(plan.record.loopAllowance["review->fix"]).toBeUndefined();
    expect(plan.record.steps["review"]?.status).toBe("failed");
    expect(plan.record.steps["review"]?.errorCode).toBe("step_failed");
    expect(plan.record.status).toBe("failed");
    expect(plan.record.errorCode).toBe("step_failed");
  });
});
