import { describe, expect, it } from "vitest";

import { evaluateWhen, readCondition, readySteps } from "./ready.js";
import { makeRecord, patchStep, playbook, step } from "./test-util.js";

describe("readySteps", () => {
  it("selects only the head of a linear chain", () => {
    const ir = playbook({
      steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] }), step({ id: "c", needs: ["b"] })],
    });
    let record = makeRecord(ir);
    expect(readySteps(record, 1_000)).toEqual({ ready: ["a"], skipped: [] });

    record = patchStep(record, "a", { status: "completed" });
    expect(readySteps(record, 1_000).ready).toEqual(["b"]);

    record = patchStep(record, "b", { status: "completed" });
    expect(readySteps(record, 1_000).ready).toEqual(["c"]);
  });

  it("runs diamond branches in parallel and waits for both before the join", () => {
    const ir = playbook({
      steps: [
        step({ id: "a" }),
        step({ id: "review", needs: ["a"] }),
        step({ id: "test", needs: ["a"] }),
        step({ id: "join", needs: ["review", "test"] }),
      ],
    });
    let record = makeRecord(ir);
    record = patchStep(record, "a", { status: "completed" });
    expect(readySteps(record, 1_000).ready).toEqual(["review", "test"]);

    record = patchStep(record, "review", { status: "completed" });
    expect(readySteps(record, 1_000).ready).toEqual(["test"]);

    record = patchStep(record, "test", { status: "completed" });
    expect(readySteps(record, 1_000).ready).toEqual(["join"]);
  });

  it("does not block on a skipped dependency", () => {
    const ir = playbook({
      steps: [step({ id: "a", when: { "inputs.mode": "infra" } }), step({ id: "b", needs: ["a"] })],
    });
    let record = makeRecord(ir, { inputs: { mode: "service" } });
    expect(readySteps(record, 1_000)).toEqual({ ready: [], skipped: ["a"] });

    record = patchStep(record, "a", { status: "skipped" });
    expect(readySteps(record, 1_000)).toEqual({ ready: ["b"], skipped: [] });
  });

  it("skips a when:false step without blocking its dependents, but not a needs-only branch", () => {
    const ir = playbook({
      steps: [
        step({ id: "a" }),
        step({ id: "maybe", needs: ["a"], when: { "steps.a.outputs.kind": "service" } }),
        step({ id: "always", needs: ["a"] }),
        step({ id: "after", needs: ["maybe"] }),
      ],
    });
    let record = makeRecord(ir);
    record = patchStep(record, "a", {
      status: "completed",
      outputs: { kind: "infra" },
      outcome: "success",
    });
    expect(readySteps(record, 1_000)).toEqual({ ready: ["always"], skipped: ["maybe"] });

    record = patchStep(record, "maybe", { status: "skipped" });
    expect(readySteps(record, 1_000)).toEqual({ ready: ["always", "after"], skipped: [] });
  });

  it("keeps a step pending until its retry window opens", () => {
    const ir = playbook({ steps: [step({ id: "a" })] });
    const record = patchStep(makeRecord(ir), "a", { status: "pending", notBefore: 2_000 });
    expect(readySteps(record, 1_999)).toEqual({ ready: [], skipped: [] });
    expect(readySteps(record, 2_000)).toEqual({ ready: ["a"], skipped: [] });
  });

  it("includes ready (concurrency-blocked) steps in the candidate set", () => {
    const ir = playbook({ steps: [step({ id: "a" })] });
    const record = patchStep(makeRecord(ir), "a", { status: "ready" });
    expect(readySteps(record, 1_000).ready).toEqual(["a"]);
  });

  it("returns nothing for a terminal run", () => {
    const ir = playbook({ steps: [step({ id: "a" })] });
    const record = makeRecord(ir);
    expect(readySteps({ ...record, status: "failed" }, 1_000)).toEqual({ ready: [], skipped: [] });
  });
});

describe("when conditions (FR21)", () => {
  const ir = playbook({
    steps: [step({ id: "a" }), step({ id: "b", needs: ["a"] })],
    inputs: { mode: { type: "enum", values: ["service", "infra"] } },
  });

  it("supports equality, array includes, and emptiness", () => {
    let record = makeRecord(ir, { inputs: { mode: "infra" } });
    record = patchStep(record, "a", {
      status: "completed",
      outputs: { kind: "service", empty: "" },
      outcome: "success",
    });
    expect(evaluateWhen({ "inputs.mode": "infra" }, record)).toBe(true);
    expect(evaluateWhen({ "playbook.inputs.mode": "infra" }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outputs.kind": ["service", "infra"] }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outputs.kind": ["docs"] }, record)).toBe(false);
    expect(evaluateWhen({ "steps.a.outputs.empty": { empty: true } }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outputs.missing": { empty: true } }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outputs.kind": { empty: false } }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outcome": "success" }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.status": "completed" }, record)).toBe(true);
    expect(evaluateWhen({ "steps.a.outputs.kind": "docs" }, record)).toBe(false);
  });

  it("requires every key to hold", () => {
    const record = makeRecord(ir, { inputs: { mode: "infra" } });
    expect(evaluateWhen({ "inputs.mode": "infra", "steps.a.status": "pending" }, record)).toBe(true);
    expect(evaluateWhen({ "inputs.mode": "infra", "steps.a.status": "completed" }, record)).toBe(false);
  });

  it("resolves unknown paths to undefined", () => {
    const record = makeRecord(ir);
    expect(readCondition(record, "steps.ghost.outputs.x")).toBeUndefined();
    expect(readCondition(record, "nonsense")).toBeUndefined();
    expect(evaluateWhen({ "nonsense": { empty: true } }, record)).toBe(true);
  });

  it("never consults an agent or model", () => {
    const record = makeRecord(ir, { inputs: { mode: "infra" } });
    // The whole condition surface is the checkpoint: the IR is not even needed here.
    expect(evaluateWhen({ "inputs.mode": ["infra"] }, record)).toBe(true);
  });
});
