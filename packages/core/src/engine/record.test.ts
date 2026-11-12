import { describe, expect, it } from "vitest";

import { next } from "./reducer.js";
import {
  createRunRecord,
  hydrateRunRecord,
  InvalidRunRecordError,
  invariantIssues,
  RunRecordSchema,
} from "./record.js";
import { makeRecord, playbook, step } from "./test-util.js";

const ir = playbook({
  steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] })],
  after: [{ id: "cleanup", title: "Cleanup", trigger: "auto", steps: [step({ id: "sweep" })] }],
});

describe("createRunRecord", () => {
  it("starts pending with every step and after-task present", () => {
    const record = makeRecord(ir, { now: 42, cwd: "/work", inputs: { issue: "x" } });
    expect(record.status).toBe("pending");
    expect(record.seq).toBe(0);
    expect(record.createdAt).toBe(42);
    expect(record.updatedAt).toBe(42);
    expect(record.playbookId).toBe("test");
    expect(record.playbookHash).toBe("test-hash-test");
    expect(record.steps).toEqual({
      a: { status: "pending", outputs: {}, loop: 0, attempts: [] },
      b: { status: "pending", outputs: {}, loop: 0, attempts: [] },
    });
    expect(record.after).toEqual({ cleanup: { status: "pending" } });
    expect(record.loops).toEqual({});
    expect(record.loopAllowance).toEqual({});
    expect(record.gates).toEqual([]);
    expect(record.exhausted).toEqual([]);
    expect(record.inputs).toEqual({ issue: "x" });
    expect(record.cwd).toBe("/work");
  });

  it("omits optional keys instead of storing undefined", () => {
    const record = makeRecord(ir);
    expect(Object.hasOwn(record, "worktree")).toBe(false);
    expect(Object.hasOwn(record, "deadline")).toBe(false);
    expect(Object.hasOwn(record, "outcome")).toBe(false);
    expect(record).not.toHaveProperty("worktree");
    expect(JSON.stringify(record)).not.toContain("undefined");
  });

  it("stores worktree and deadline when supplied", () => {
    const record = createRunRecord({
      id: "run-1",
      ir,
      inputs: {},
      cwd: "/work/tree",
      now: 10,
      deadline: 99,
      worktree: { path: "/home/w", branch: "argos/run-1", baseSha: "abc123" },
    });
    expect(record.worktree).toEqual({ path: "/home/w", branch: "argos/run-1", baseSha: "abc123" });
    expect(record.deadline).toBe(99);
  });

  it("stores script pins when supplied and omits the key otherwise (FR3)", () => {
    const sha = "a".repeat(64);
    const pinned = createRunRecord({
      id: "run-1",
      ir,
      inputs: {},
      cwd: "/work/tree",
      now: 10,
      scripts: { "tool.mjs": { path: "/work/tree/.argos/scripts/tool.mjs", sha256: sha } },
    });
    expect(pinned.scripts).toEqual({
      "tool.mjs": { path: "/work/tree/.argos/scripts/tool.mjs", sha256: sha },
    });
    expect(Object.isFrozen(pinned.scripts)).toBe(true);
    expect(Object.hasOwn(pinned.scripts?.["tool.mjs"] ?? {}, "sha256")).toBe(true);

    // A record created before pinning (or a playbook without script steps) has no key at all.
    expect(Object.hasOwn(makeRecord(ir), "scripts")).toBe(false);
  });

  it("freezes the record deeply", () => {
    const record = makeRecord(ir);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.steps)).toBe(true);
    expect(Object.isFrozen(record.steps["a"])).toBe(true);
    expect(Object.isFrozen(record.ir)).toBe(true);
  });

  it("validates against RunRecordSchema", () => {
    expect(RunRecordSchema.safeParse(makeRecord(ir)).success).toBe(true);
    expect(invariantIssues(makeRecord(ir))).toEqual([]);
  });
});

describe("hydrateRunRecord", () => {
  it("round-trips a checkpoint byte-identically", () => {
    let record = makeRecord(ir, { inputs: { issue: "x" } });
    record = next(record, { type: "tick", now: 1_100 }).record;
    record = next(record, { type: "stepAttemptStarted", stepId: "a", attempt: 1, startedAt: 1_100 }).record;
    record = next(record, { type: "stepSettled", stepId: "a", outcome: "success", outputs: { plan: "p" }, endedAt: 1_200, usage: { totalTokens: 3 } }).record;

    const json = JSON.stringify(record);
    const hydrated = hydrateRunRecord(json);
    expect(JSON.stringify(hydrated)).toBe(json);
    expect(hydrated).toEqual(record);
  });

  it("round-trips a pinned record byte-identically, and an unpinned one keeps the key absent", () => {
    // FR3: the pin is additive — old JSON hydrates unchanged and new JSON keeps its key order.
    const pinned = createRunRecord({
      id: "run-1",
      ir,
      inputs: {},
      cwd: "/work/tree",
      now: 10,
      scripts: { "tool.mjs": { path: "/work/tree/.argos/scripts/tool.mjs", sha256: "b".repeat(64) } },
    });
    const json = JSON.stringify(pinned);
    expect(json).toContain('"scripts"');
    expect(JSON.stringify(hydrateRunRecord(json))).toBe(json);

    const plain = JSON.stringify(makeRecord(ir));
    expect(plain).not.toContain('"scripts"');
    expect(JSON.stringify(hydrateRunRecord(plain))).toBe(plain);
  });

  it("rejects a malformed script pin instead of trusting it", () => {
    for (const scripts of [
      { "tool.mjs": { path: "", sha256: "c".repeat(64) } },
      { "tool.mjs": { path: "/work/tool.mjs", sha256: "not-a-sha256" } },
      { "tool.mjs": { path: "/work/tool.mjs" } },
      { "tool.mjs": { path: "/work/tool.mjs", sha256: "c".repeat(64), extra: true } },
    ]) {
      const record = JSON.parse(JSON.stringify(makeRecord(ir))) as Record<string, unknown>;
      record["scripts"] = scripts;
      expect(() => hydrateRunRecord(record), JSON.stringify(scripts)).toThrow(InvalidRunRecordError);
    }
  });

  it("round-trips a record parked on a gate, including loop and ask choice metadata", () => {
    const gateIr = playbook({
      steps: [
        step({ id: "a" }),
        step({
          id: "review",
          needs: ["a"],
          outcomes: ["changes_requested"],
          on: {
            changes_requested: {
              kind: "ask",
              ask: "Proceed?",
              target: "a",
              maxLoops: 2,
              choices: {
                retry: { label: "Retry", comment: "required", outputs: { note: "{{ steps.a.outputs.x }}" } },
                skip: { label: "Skip", comment: "none", outcome: "changes_requested" },
              },
            },
          },
        }),
      ],
    });
    let record = makeRecord(gateIr, { now: 1_000 });
    record = next(record, { type: "tick", now: 1_100 }).record;
    record = next(record, { type: "stepSettled", stepId: "a", outcome: "success", endedAt: 1_200 }).record;
    record = next(record, {
      type: "stepSettled",
      stepId: "review",
      outcome: "changes_requested",
      endedAt: 1_300,
    }).record;
    expect(record.gates).toHaveLength(1);

    const json = JSON.stringify(record);
    expect(JSON.stringify(hydrateRunRecord(json))).toBe(json);
  });

  it("preserves a different key order instead of rebuilding the object", () => {
    const record = makeRecord(ir);
    const reordered = JSON.stringify({
      seq: record.seq,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      exhausted: record.exhausted,
      after: record.after,
      gates: record.gates,
      loopAllowance: record.loopAllowance,
      loops: record.loops,
      steps: record.steps,
      errorCode: undefined,
      outcome: undefined,
      deadline: undefined,
      worktree: undefined,
      cwd: record.cwd,
      status: record.status,
      inputs: record.inputs,
      ir: record.ir,
      playbookHash: record.playbookHash,
      playbookId: record.playbookId,
      id: record.id,
    });
    // `undefined` keys are dropped by JSON.stringify, so the result must still hydrate.
    const hydrated = hydrateRunRecord(reordered);
    expect(JSON.stringify(hydrated)).toBe(reordered);
  });

  it("rejects unknown keys instead of silently stripping them", () => {
    const record = JSON.parse(JSON.stringify(makeRecord(ir))) as Record<string, unknown>;
    record["mystery"] = true;
    expect(() => hydrateRunRecord(record)).toThrow(InvalidRunRecordError);
    try {
      hydrateRunRecord(record);
    } catch (error) {
      expect((error as InvalidRunRecordError).issues.join(" ")).toContain("mystery");
    }
  });

  it("rejects a bad status", () => {
    const record = JSON.parse(JSON.stringify(makeRecord(ir))) as Record<string, unknown>;
    record["status"] = "exploded";
    expect(() => hydrateRunRecord(record)).toThrow(/invalid run record/);
  });

  it("rejects a checkpoint whose steps do not match the frozen IR", () => {
    const record = JSON.parse(JSON.stringify(makeRecord(ir))) as Record<string, unknown>;
    const steps = record["steps"] as Record<string, unknown>;
    steps["ghost"] = { status: "pending", outputs: {}, loop: 0, attempts: [] };
    expect(() => hydrateRunRecord(record)).toThrow(/not a step of the frozen IR/);
  });

  it("rejects a mismatched playbook hash", () => {
    const record = JSON.parse(JSON.stringify(makeRecord(ir))) as Record<string, unknown>;
    record["playbookHash"] = "other";
    expect(() => hydrateRunRecord(record)).toThrow(/playbookHash/);
  });

  it("rejects invalid JSON and malformed attempts", () => {
    expect(() => hydrateRunRecord("{not json")).toThrow(/not valid JSON/);
    const record = JSON.parse(JSON.stringify(makeRecord(ir))) as {
      steps: Record<string, { attempts: unknown[] }>;
    };
    record.steps["a"]!.attempts.push({ n: 1, startedAt: 1 }, { n: 1, startedAt: 2 });
    expect(() => hydrateRunRecord(record)).toThrow(/duplicate attempt/);
  });
});
