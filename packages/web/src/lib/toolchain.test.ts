/**
 * Phase 1 toolchain check: the web workspace must resolve the published contract schemas through
 * the workspace link (packages/core `exports` → dist) and parse a real `RunSummary`.
 *
 * This is deliberately not a placeholder: if the workspace link, the ESM resolution, or zod breaks,
 * every later phase (which parses every response at the boundary) would break with it.
 */
import { RunSummarySchema, RunDetailSchema } from "@thaodangspace/argos-core/rpc/contracts";
import { describe, expect, it } from "vitest";

const summary = {
  id: "01J0000000000000000000000A",
  playbookId: "release",
  playbookHash: "abc123",
  status: "running",
  inputs: {},
  cwd: "/tmp/repo",
  steps: [
    {
      id: "build",
      title: "Build",
      kind: "agent",
      status: "running",
      attemptCount: 1,
      startedAt: 1_700_000_000_000,
    },
  ],
  gates: [],
  after: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  seq: 3,
} as const;

describe("web toolchain", () => {
  it("parses a RunSummary through the shared contract", () => {
    const parsed = RunSummarySchema.parse(summary);
    expect(parsed.status).toBe("running");
    expect(parsed.steps[0]?.id).toBe("build");
  });

  it("extends the same summary into a RunDetail", () => {
    const detail = RunDetailSchema.parse({
      ...summary,
      steps: [{ ...summary.steps[0], attempts: [], outputs: {} }],
      history: [{ at: 1, seq: 1, type: "run_started", stepId: null, attempt: null, detail: null }],
    });
    expect(detail.history).toHaveLength(1);
  });
});
