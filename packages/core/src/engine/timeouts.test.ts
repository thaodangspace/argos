import { describe, expect, it } from "vitest";

import { next } from "./reducer.js";
import type { RunRecord } from "./record.js";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  resolveTimeoutValue,
  retryBackoffMs,
  stepTimeoutMs,
  timedOutAttempts,
} from "./timeouts.js";
import { makeRecord, playbook, step } from "./test-util.js";

function tick(record: RunRecord, now: number): ReturnType<typeof next> {
  return next(record, { type: "tick", now });
}

function running(record: RunRecord, now = 1_000): RunRecord {
  return tick(record, now).record;
}

describe("stepTimeoutMs", () => {
  it("defaults to 30 minutes", () => {
    expect(stepTimeoutMs(step({ id: "a" }), {})).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs(step({ id: "a", timeout: 5_000 }), {})).toBe(5_000);
  });

  it("parses duration strings exactly like the loader", () => {
    expect(stepTimeoutMs(step({ id: "a", timeout: "90s" }), {})).toBe(90_000);
    expect(stepTimeoutMs(step({ id: "a", timeout: "1h" }), {})).toBe(3_600_000);
  });

  it("resolves {{ inputs.t }} at evaluation time, from a number or a duration", () => {
    const templated = step({ id: "a", timeout: "{{ inputs.t }}" });
    expect(stepTimeoutMs(templated, { t: 5_000 })).toBe(5_000);
    expect(stepTimeoutMs(templated, { t: "5s" })).toBe(5_000);
    expect(resolveTimeoutValue("{{ playbook.inputs.t }}", { t: 12 })).toBe(12);
  });

  it("falls back to the default for unresolvable or invalid values", () => {
    const templated = step({ id: "a", timeout: "{{ inputs.missing }}" });
    expect(stepTimeoutMs(templated, {})).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs(step({ id: "a", timeout: "soon" }), {})).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs(step({ id: "a", timeout: -1 }), {})).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  it("uses deterministic exponential backoff capped at 60s", () => {
    expect(retryBackoffMs(1)).toBe(1_000);
    expect(retryBackoffMs(2)).toBe(2_000);
    expect(retryBackoffMs(3)).toBe(4_000);
    expect(retryBackoffMs(20)).toBe(60_000);
  });
});

describe("attempt timeouts (FR18)", () => {
  const ir = playbook({ steps: [step({ id: "a", timeout: 5_000 })] });

  it("records the attempt and fails the step when retries are exhausted", () => {
    let record = running(makeRecord(ir, { now: 1_000 }), 1_000);
    expect(timedOutAttempts(record, 5_999)).toEqual([]);
    expect(timedOutAttempts(record, 6_000)).toEqual([
      { stepId: "a", attempt: 1, deadline: 6_000, reason: "step_timeout" },
    ]);

    // Just before the deadline nothing changes.
    const early = tick(record, 5_999);
    expect(early.effects).toEqual([]);
    expect(early.record.seq).toBe(record.seq);

    const timedOut = tick(record, 6_000);
    record = timedOut.record;
    expect(record.steps["a"]?.attempts).toEqual([
      {
        n: 1,
        requestId: "argos:run-1:a:1",
        startedAt: 1_000,
        endedAt: 6_000,
        outcome: "timeout",
        errorCode: "step_timeout",
      },
    ]);
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.errorCode).toBe("step_timeout");
    expect(record.status).toBe("failed");
    expect(record.errorCode).toBe("step_timeout");
    expect(timedOut.effects).toContainEqual({ type: "finishRun", status: "failed", errorCode: "step_timeout" });
  });

  it("retries per `retries` after a backoff window and dispatches a new attempt", () => {
    const retryIr = playbook({ steps: [step({ id: "a", timeout: 5_000, retries: 1 })] });
    let record = running(makeRecord(retryIr, { now: 1_000 }), 1_000);

    const firstTimeout = tick(record, 6_000);
    record = firstTimeout.record;
    expect(record.steps["a"]?.status).toBe("pending");
    expect(record.steps["a"]?.errorCode).toBeUndefined();
    expect(record.steps["a"]?.attempts[0]).toMatchObject({ outcome: "timeout", errorCode: "step_timeout" });
    expect(record.steps["a"]?.notBefore).toBe(7_000);
    expect(firstTimeout.effects).toContainEqual({ type: "scheduleWake", at: 7_000 });

    const tooEarly = tick(record, 6_999);
    expect(tooEarly.effects).toEqual([]);
    expect(tooEarly.record.steps["a"]?.status).toBe("pending");

    const retried = tick(record, 7_000);
    record = retried.record;
    expect(record.steps["a"]?.status).toBe("running");
    expect(record.steps["a"]?.attempts).toHaveLength(2);
    expect(retried.effects).toContainEqual(
      expect.objectContaining({ type: "dispatchStep", stepId: "a", attempt: 2 }),
    );

    record = tick(record, 12_000).record;
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.status).toBe("failed");
  });

  it("supports a templated timeout resolved from run inputs", () => {
    const templated = playbook({
      steps: [step({ id: "a", timeout: "{{ inputs.t }}" })],
    });
    let record = running(makeRecord(templated, { now: 1_000, inputs: { t: 5_000 } }), 1_000);
    expect(tick(record, 5_999).record.status).toBe("running");
    record = tick(record, 6_000).record;
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.errorCode).toBe("step_timeout");
  });

  it("a global run deadline fails the run regardless of step retries", () => {
    const retryIr = playbook({ steps: [step({ id: "a", timeout: "1h", retries: 5 })] });
    let record = running(makeRecord(retryIr, { now: 1_000, deadline: 2_000 }), 1_000);

    const deadline = tick(record, 2_000);
    record = deadline.record;
    expect(record.status).toBe("failed");
    expect(record.errorCode).toBe("step_timeout");
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["a"]?.attempts[0]).toMatchObject({ endedAt: 2_000, outcome: "timeout" });
    expect(deadline.effects).toContainEqual({ type: "finishRun", status: "failed", errorCode: "step_timeout" });
  });

  it("marks never-started steps skipped when the run deadline passes", () => {
    const twoSteps = playbook({
      steps: [step({ id: "a", timeout: "1h" }), step({ id: "b", needs: ["a"] })],
    });
    let record = running(makeRecord(twoSteps, { now: 1_000, deadline: 2_000 }), 1_000);
    record = tick(record, 2_000).record;
    expect(record.steps["a"]?.status).toBe("failed");
    expect(record.steps["b"]?.status).toBe("skipped");
    expect(record.status).toBe("failed");
  });
});
