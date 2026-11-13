/**
 * Read-model detail projection (`GET /runs/:id`): the list stays lean, the detail carries what the
 * panel's per-step log renders (attempts, outcome, declared outputs) and nothing else.
 */

import { describe, expect, it } from "vitest";

import { createRunRecord, next, type RunRecord } from "../../src/engine/index.js";
import { playbook, step } from "../../src/engine/test-util.js";
import {
  RunDetailSchema,
  STEP_OUTPUT_VALUE_LIMIT,
  type RunDetail,
} from "../../src/rpc/contracts.js";
import { toRunDetail, toRunSummary } from "../../src/rpc/summary.js";

const ir = playbook({
  id: "demo",
  steps: [
    step({ id: "pick", title: "Pick" }),
    step({ id: "ship", title: "Ship", needs: ["pick"] }),
  ],
});

/** A run with one settled step: an attempt, an outcome, and outputs (one of them secret-named). */
function settledRecord(): RunRecord {
  let record = createRunRecord({ id: "run-1", ir, inputs: {}, cwd: "/repo", now: 1_000 });
  record = next(record, { type: "tick", now: 1_000 }).record;
  record = next(record, {
    type: "stepAttemptStarted",
    stepId: "pick",
    attempt: 1,
    startedAt: 1_100,
    target: "claude/opus",
    now: 1_100,
  }).record;
  record = next(record, {
    type: "stepSettled",
    stepId: "pick",
    endedAt: 2_000,
    outcome: "success",
    outputs: { stdout: "specs/VP-7.md\n", api_token: "secret-value" },
    usage: { inputTokens: 12, outputTokens: 34 },
    now: 2_000,
  }).record;
  return record;
}

function detail(record: RunRecord): RunDetail {
  return toRunDetail({ taskId: "42", record }, { events: [] });
}

describe("toRunDetail (step logs)", () => {
  it("carries attempts, outcome, and declared outputs per step", () => {
    const run = detail(settledRecord());
    expect(run.steps.map((entry) => entry.id)).toEqual(["pick", "ship"]);

    const pick = run.steps[0];
    expect(pick).toMatchObject({
      id: "pick",
      title: "Pick",
      status: "completed",
      outcome: "success",
      attemptCount: 1,
      startedAt: 1_100,
      endedAt: 2_000,
      attempts: [
        {
          n: 1,
          startedAt: 1_100,
          endedAt: 2_000,
          target: "claude/opus",
          usage: { inputTokens: 12, outputTokens: 34 },
        },
      ],
    });
    // The declared outputs are the step's log; a credential-shaped name never crosses the wire.
    expect(pick?.outputs).toEqual({ stdout: "specs/VP-7.md\n" });
    expect(pick).not.toHaveProperty("prompt");
    expect(JSON.stringify(pick)).not.toContain("secret-value");

    // The next step was dispatched by the settle tick: it has an open attempt and no output.
    expect(run.steps[1]?.attempts).toEqual([{ n: 1, startedAt: 2_000 }]);
    expect(run.steps[1]).not.toHaveProperty("outputs");

    // The strict detail schema accepts exactly the projected shape.
    expect(RunDetailSchema.parse(run).steps[0]?.attempts).toHaveLength(1);
  });

  it("truncates an oversized output string and keeps the marker", () => {
    let record = createRunRecord({ id: "run-2", ir, inputs: {}, cwd: "/repo", now: 1_000 });
    record = next(record, { type: "tick", now: 1_000 }).record;
    record = next(record, {
      type: "stepSettled",
      stepId: "pick",
      endedAt: 2_000,
      outcome: "success",
      outputs: { stdout: "x".repeat(STEP_OUTPUT_VALUE_LIMIT + 50) },
      now: 2_000,
    }).record;

    const pick = detail(record).steps[0];
    const stdout = pick?.outputs?.["stdout"];
    expect(typeof stdout).toBe("string");
    expect(String(stdout)).toHaveLength(STEP_OUTPUT_VALUE_LIMIT + "… (truncated)".length);
    expect(String(stdout).endsWith("… (truncated)")).toBe(true);
  });

  it("keeps the list summary lean (no attempts, outputs, or outcome)", () => {
    const summary = toRunSummary({ taskId: "42", record: settledRecord() });
    const pick = summary.steps[0] as unknown as Record<string, unknown>;
    expect(pick["attemptCount"]).toBe(1);
    expect(pick["attempts"]).toBeUndefined();
    expect(pick["outputs"]).toBeUndefined();
    expect(pick["outcome"]).toBeUndefined();
  });
});
