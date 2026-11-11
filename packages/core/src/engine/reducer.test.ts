import { describe, expect, it } from "vitest";

import { next } from "./reducer.js";
import type { Effect, EngineEvent } from "./reducer.js";
import { isTerminalRunStatus, type RunRecord } from "./record.js";
import { goto, makeRecord, mulberry32, playbook, step } from "./test-util.js";
import type { PlaybookIR } from "../playbook/ir.js";

function tick(record: RunRecord, now: number): { record: RunRecord; effects: readonly Effect[] } {
  return next(record, { type: "tick", now });
}

function settle(
  record: RunRecord,
  stepId: string,
  outcome: string,
  endedAt: number,
  outputs?: Readonly<Record<string, string>>,
): { record: RunRecord; effects: readonly Effect[] } {
  return next(record, {
    type: "stepSettled",
    stepId,
    outcome,
    endedAt,
    ...(outputs === undefined ? {} : { outputs }),
  });
}

describe("selection loop (FR14)", () => {
  const diamond = playbook({
    steps: [
      step({ id: "a" }),
      step({ id: "review", needs: ["a"] }),
      step({ id: "test", needs: ["a"] }),
      step({ id: "join", needs: ["review", "test"] }),
    ],
  });

  it("dispatches the whole ready set in one event", () => {
    let record = tick(makeRecord(diamond, { now: 1_000 }), 1_000).record;
    const settled = settle(record, "a", "success", 1_100);
    record = settled.record;
    expect(settled.effects).toEqual([
      { type: "dispatchStep", stepId: "review", attempt: 1, requestId: "argos:run-1:review:1" },
      { type: "dispatchStep", stepId: "test", attempt: 1, requestId: "argos:run-1:test:1" },
    ]);
    expect(record.steps["review"]?.status).toBe("running");
    expect(record.steps["test"]?.status).toBe("running");
    expect(record.steps["join"]?.status).toBe("pending");
  });

  it("bounds simultaneous running steps by concurrency and parks the rest as ready", () => {
    const bounded = playbook({
      steps: diamond.steps,
      concurrency: 1,
    });
    let record = tick(makeRecord(bounded, { now: 1_000 }), 1_000).record;
    const settled = settle(record, "a", "success", 1_100);
    record = settled.record;
    expect(settled.effects).toEqual([
      { type: "dispatchStep", stepId: "review", attempt: 1, requestId: "argos:run-1:review:1" },
    ]);
    expect(record.steps["review"]?.status).toBe("running");
    expect(record.steps["test"]?.status).toBe("ready");

    const nextUp = settle(record, "review", "success", 1_200);
    record = nextUp.record;
    expect(nextUp.effects).toEqual([
      { type: "dispatchStep", stepId: "test", attempt: 1, requestId: "argos:run-1:test:1" },
    ]);
    expect(record.steps["test"]?.status).toBe("running");
  });

  it("finishes the run when every step is terminal", () => {
    const ir = playbook({ steps: [step({ id: "only" })] });
    let record = tick(makeRecord(ir, { now: 1_000 }), 1_000).record;
    const settled = settle(record, "only", "success", 1_100);
    record = settled.record;
    expect(record.status).toBe("completed");
    expect(settled.effects).toContainEqual({ type: "finishRun", status: "completed" });
    expect(tick(record, 2_000).effects).toEqual([]);
  });

  it("records launch metadata from stepAttemptStarted without reopening a settled attempt", () => {
    const ir = playbook({ steps: [step({ id: "a" })] });
    let record = tick(makeRecord(ir, { now: 1_000 }), 1_000).record;
    record = next(record, {
      type: "stepAttemptStarted",
      stepId: "a",
      attempt: 1,
      startedAt: 1_004,
      agentId: "agent-1",
      target: "claude/opus",
      requestId: "argos:run-1:a:1",
    }).record;
    expect(record.steps["a"]?.attempts[0]).toEqual({
      n: 1,
      startedAt: 1_004,
      requestId: "argos:run-1:a:1",
      agentId: "agent-1",
      target: "claude/opus",
    });

    record = settle(record, "a", "success", 1_100).record;
    const late = next(record, {
      type: "stepAttemptStarted",
      stepId: "a",
      attempt: 1,
      startedAt: 1_200,
      agentId: "agent-2",
    });
    expect(late.record.steps["a"]?.attempts[0]?.startedAt).toBe(1_004);
    expect(late.record.steps["a"]?.attempts[0]?.agentId).toBe("agent-1");
  });

  it("does not mutate the input record", () => {
    const initial = makeRecord(diamond, { now: 1_000 });
    const snapshot = JSON.stringify(initial);
    tick(initial, 1_000);
    expect(JSON.stringify(initial)).toBe(snapshot);
    expect(Object.isFrozen(initial)).toBe(true);
  });

  it("bumps seq only when the record changes and takes updatedAt from the event", () => {
    const ir = playbook({ steps: [step({ id: "a" })] });
    let record = tick(makeRecord(ir, { now: 1_000 }), 1_000).record;
    expect(record.seq).toBe(1);
    expect(record.updatedAt).toBe(1_000);

    const idle = tick(record, 1_100);
    expect(idle.record.seq).toBe(1);
    expect(idle.record.updatedAt).toBe(1_000);

    record = settle(record, "a", "success", 1_200).record;
    expect(record.seq).toBe(2);
    expect(record.updatedAt).toBe(1_200);
  });
});

describe("gate steps (FR19/FR20 decision half)", () => {
  const withGate = playbook({
    steps: [
      step({ id: "a" }),
      step({
        id: "approve",
        needs: ["a"],
        kind: "gate",
        outcomes: ["approved", "rejected"],
        gate: {
          question: "Merge?",
          choices: {
            approved: { label: "Approve", comment: "none" },
            rejected: { label: "Reject", comment: "optional", color: "danger" },
          },
        },
        on: { rejected: goto("a") },
      }),
    ],
  });

  it("opens a gate and parks the run in waiting", () => {
    let record = tick(makeRecord(withGate, { now: 1_000 }), 1_000).record;
    const opened = settle(record, "a", "success", 1_100);
    record = opened.record;

    expect(opened.effects).toEqual([
      expect.objectContaining({
        type: "openGate",
        gateId: "approve:1",
        kind: "step",
        stepId: "approve",
        question: "Merge?",
      }),
    ]);
    expect(record.steps["approve"]?.status).toBe("waiting");
    expect(record.status).toBe("waiting");
    expect(record.gates[0]).toMatchObject({ id: "approve:1", status: "pending", createdAt: 1_100 });
  });

  it("applies the approved outcome and finishes", () => {
    let record = tick(makeRecord(withGate, { now: 1_000 }), 1_000).record;
    record = settle(record, "a", "success", 1_100).record;
    const decided = next(record, {
      type: "gateDecided",
      gateId: "approve:1",
      decision: "approved",
      decidedBy: "thao",
      decidedVia: "panel",
      decidedAt: 1_200,
      now: 1_200,
    });
    record = decided.record;

    expect(record.gates[0]).toMatchObject({
      status: "decided",
      decision: "approved",
      decidedBy: "thao",
      decidedVia: "panel",
      decidedAt: 1_200,
    });
    expect(record.steps["approve"]?.status).toBe("completed");
    expect(record.status).toBe("completed");
    expect(decided.effects).toContainEqual({ type: "finishRun", status: "completed" });
  });

  it("applies a goto outcome and forwards the comment as feedback", () => {
    let record = tick(makeRecord(withGate, { now: 1_000 }), 1_000).record;
    record = settle(record, "a", "success", 1_100).record;
    const decided = next(record, {
      type: "gateDecided",
      gateId: "approve:1",
      decision: "rejected",
      comment: "needs tests",
      decidedAt: 1_200,
      now: 1_200,
    });
    record = decided.record;

    expect(record.loops).toEqual({ "approve->a": 1 });
    expect(record.steps["a"]?.feedback).toContain("needs tests");
    expect(record.steps["a"]?.status).toBe("running");
    expect(decided.effects).toContainEqual({
      type: "dispatchStep",
      stepId: "a",
      attempt: 2,
      requestId: "argos:run-1:a:2",
    });
  });

  it("numbers a re-opened gate with the next n", () => {
    let record = tick(makeRecord(withGate, { now: 1_000 }), 1_000).record;
    record = settle(record, "a", "success", 1_100).record;
    record = next(record, {
      type: "gateDecided",
      gateId: "approve:1",
      decision: "rejected",
      decidedAt: 1_200,
      now: 1_200,
    }).record;
    record = settle(record, "a", "success", 1_300).record;

    expect(record.gates.map((gate) => [gate.id, gate.status])).toEqual([
      ["approve:1", "decided"],
      ["approve:2", "pending"],
    ]);
    expect(record.status).toBe("waiting");
  });
});

describe("branch steps (FR21)", () => {
  const branching = playbook({
    steps: [
      step({ id: "a", outputs: { kind: { type: "string" } } }),
      step({
        id: "route",
        needs: ["a"],
        kind: "branch",
        outcomes: ["service", "other"],
        branch: {
          cases: [
            { name: "service", when: { "steps.a.outputs.kind": "service" } },
            { name: "other" },
          ],
        },
      }),
      step({ id: "ship", needs: ["route"] }),
    ],
  });

  it("evaluates cases in declared order and settles inside the same event", () => {
    let record = tick(makeRecord(branching, { now: 1_000 }), 1_000).record;
    const settled = settle(record, "a", "success", 1_100, { kind: "service" });
    record = settled.record;
    expect(record.steps["route"]).toMatchObject({ status: "completed", outcome: "service" });
    expect(record.steps["ship"]?.status).toBe("running");
    expect(settled.effects).toContainEqual(
      expect.objectContaining({ type: "dispatchStep", stepId: "ship" }),
    );
  });

  it("falls through to the last (else) case", () => {
    let record = tick(makeRecord(branching, { now: 1_000 }), 1_000).record;
    record = settle(record, "a", "success", 1_100, { kind: "infra" }).record;
    expect(record.steps["route"]).toMatchObject({ status: "completed", outcome: "other" });
    expect(record.steps["ship"]?.status).toBe("running");
  });
});

describe("after-tasks and cancellation", () => {
  it("emits startAfterTask for auto tasks only, after the main graph is terminal", () => {
    const ir = playbook({
      steps: [step({ id: "a" })],
      after: [
        { id: "cleanup", title: "Cleanup", trigger: "auto", steps: [step({ id: "sweep" })] },
        { id: "report", title: "Report", trigger: "manual", steps: [step({ id: "write" })] },
      ],
    });
    let record = tick(makeRecord(ir, { now: 1_000 }), 1_000).record;
    const done = settle(record, "a", "success", 1_100);
    record = done.record;

    expect(done.effects).toContainEqual({ type: "startAfterTask", id: "cleanup" });
    expect(done.effects).not.toContainEqual({ type: "startAfterTask", id: "report" });
    expect(record.after).toEqual({
      cleanup: { status: "running", startedAt: 1_100 },
      report: { status: "pending" },
    });
    expect(record.status).toBe("completed");
  });

  it("cancels running work, skips queued work, and is terminal", () => {
    const ir = playbook({
      steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] })],
    });
    let record = tick(makeRecord(ir, { now: 1_000 }), 1_000).record;
    const cancelled = next(record, { type: "cancel", now: 1_500 });
    record = cancelled.record;

    expect(record.status).toBe("cancelled");
    expect(record.steps["a"]).toMatchObject({ status: "failed" });
    expect(record.steps["a"]?.attempts[0]).toMatchObject({ outcome: "cancelled", endedAt: 1_500 });
    expect(record.steps["b"]?.status).toBe("skipped");
    expect(cancelled.effects).toEqual([{ type: "finishRun", status: "cancelled" }]);
    expect(tick(record, 2_000).effects).toEqual([]);
  });
});

// ------------------------------------------------------------------ property

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("empty pick");
  return item;
}

function terminal(record: RunRecord): boolean {
  return isTerminalRunStatus(record.status);
}

const propertyIr: PlaybookIR = playbook({
  id: "property",
  steps: [
    step({ id: "a", timeout: "1h", outputs: { plan: { type: "string" } } }),
    step({ id: "b", needs: ["a"], timeout: "1h", outputs: { review: { type: "string" } } }),
    step({ id: "c", needs: ["a"], timeout: "1h", outputs: { tests: { type: "string" } } }),
    step({
      id: "d",
      needs: ["b", "c"],
      timeout: "1h",
      outcomes: ["ok", "bad"],
      on: { bad: goto("a", 2) },
    }),
    step({
      id: "gate",
      needs: ["d"],
      kind: "gate",
      timeout: "1h",
      outcomes: ["approved", "rejected"],
      gate: {
        question: "Ship?",
        choices: {
          approved: { label: "Approve", comment: "none" },
          rejected: { label: "Reject", comment: "optional" },
        },
      },
    }),
  ],
  after: [{ id: "cleanup", title: "Cleanup", trigger: "auto", steps: [step({ id: "sweep" })] }],
});

/**
 * Property: over 1000 seeded random (but valid) event sequences, the reducer
 * (a) never drops an output key, never rewrites the outputs of a step that stayed completed,
 * (b) is deterministic: replaying the same events from the same checkpoint yields the same record
 * and the same effects.
 */
describe("property: outputs are monotonic and replay is deterministic", () => {
  it("holds across 1000 random valid sequences", () => {
    let totalEvents = 0;
    let completedRuns = 0;

    for (let seed = 0; seed < 1_000; seed += 1) {
      const random = mulberry32(0x9e3779b9 + seed);
      const initial = makeRecord(propertyIr, { now: 0 });
      let record = initial;
      let now = 0;
      const events: EngineEvent[] = [];
      const results: Array<{ record: RunRecord; effects: readonly Effect[] }> = [];

      for (let index = 0; index < 30 && !terminal(record); index += 1) {
        now += 1 + Math.floor(random() * 25);
        const gate = record.gates.find((candidate) => candidate.status === "pending");
        let event: EngineEvent;
        if (gate !== undefined) {
          event = {
            type: "gateDecided",
            gateId: gate.id,
            decision: pick(random, Object.keys(gate.choices)),
            decidedAt: now,
            now,
          };
        } else {
          const running = propertyIr.steps.filter(
            (definition) => record.steps[definition.id]?.status === "running",
          );
          const definition = running.length === 0 ? undefined : pick(random, running);
          if (definition === undefined) {
            event = { type: "tick", now };
          } else {
            const outcome = pick(random, definition.outcomes);
            const outputs: Record<string, string> = {};
            for (const name of Object.keys(definition.outputs)) {
              outputs[name] = `${definition.id}:${now}`;
            }
            event = {
              type: "stepSettled",
              stepId: definition.id,
              outcome,
              endedAt: now,
              outputs,
            };
          }
        }

        const result = next(record, event);
        for (const definition of propertyIr.steps) {
          const before = record.steps[definition.id];
          const after = result.record.steps[definition.id];
          if (before === undefined || after === undefined) continue;
          for (const key of Object.keys(before.outputs)) {
            expect(after.outputs).toHaveProperty(key);
          }
          if (before.status === "completed" && after.status === "completed") {
            expect(after.outputs).toEqual(before.outputs);
          }
        }

        record = result.record;
        events.push(event);
        results.push(result);
        totalEvents += 1;
      }

      if (record.status === "completed") completedRuns += 1;

      // Replay determinism, record and effects.
      let replay = initial;
      for (const [index, event] of events.entries()) {
        const expected = results[index];
        const actual = next(replay, event);
        expect(JSON.stringify(actual.record)).toBe(JSON.stringify(expected?.record));
        expect(actual.effects).toEqual(expected?.effects);
        replay = actual.record;
      }
      expect(Object.isFrozen(record)).toBe(true);
    }

    expect(totalEvents).toBeGreaterThanOrEqual(1_000);
    expect(completedRuns).toBeGreaterThan(0);
  });
});
