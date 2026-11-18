/**
 * The shared view model (spec FR6): labels/tones, history text for every event type, the step log,
 * run views and grouping, gate views, the start form, and the formatters.
 *
 * These are the assertions the Paseo panel used to make; they now run against the core subpath so a
 * third client cannot use an untested copy.
 */

import { describe, expect, it } from "vitest";

import {
  RunDetailSchema,
  RunSummarySchema,
  type GateSummary,
  type HistoryEvent,
  type RunDetail,
  type RunSummary,
  type StepSummary,
} from "../../src/rpc/contracts.js";
import { HISTORY_EVENT_TYPES } from "../../src/history.js";
import {
  buildRunLog,
  buildStepLog,
  compactUsage,
  formatDuration,
  formatRelative,
  formatTokens,
  gateView,
  groupRuns,
  historyText,
  logText,
  panelView,
  parseStartForm,
  runMatchesFilter,
  runStatusTone,
  runView,
  shortId,
  sortRuns,
  pendingGates,
  RUN_FILTERS,
  RUN_STATUS_LABELS,
  STEP_STATUS_LABELS,
} from "../../src/view/index.js";

const NOW = 1_700_000_100_000;

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return RunSummarySchema.parse({
    id: "01J0000000000000000000000A",
    playbookId: "release",
    playbookHash: "hash-a",
    status: "running",
    inputs: { version: "1.2.3", dry_run: false },
    cwd: "/repo",
    steps: [
      {
        id: "build",
        title: "Build",
        kind: "agent",
        status: "completed",
        attemptCount: 1,
        startedAt: NOW - 60_000,
        endedAt: NOW - 30_000,
        usage: { totalCostUsd: 0.25 },
      },
      {
        id: "ship",
        title: "Ship",
        kind: "script",
        status: "running",
        attemptCount: 0,
        startedAt: NOW - 20_000,
      },
    ],
    gates: [],
    after: [],
    usage: { totalCostUsd: 0.25 },
    createdAt: NOW - 120_000,
    updatedAt: NOW - 5_000,
    seq: 4,
    ...overrides,
  });
}

function gate(overrides: Partial<GateSummary> = {}): GateSummary {
  return {
    runId: "01J0000000000000000000000A",
    gateId: "ship:1",
    stepId: "ship",
    kind: "step",
    question: "Ship it?",
    choices: {
      approve: { label: "Approve", comment: "optional", color: "success" },
      reject: { label: "Reject", comment: "required", color: "danger" },
    },
    status: "pending",
    ...overrides,
  };
}

function detail(): RunDetail {
  return RunDetailSchema.parse({
    ...summary(),
    steps: [
      {
        id: "build",
        title: "Build",
        kind: "agent",
        status: "completed",
        attemptCount: 1,
        startedAt: NOW - 60_000,
        endedAt: NOW - 30_000,
        outcome: "success",
        attempts: [
          {
            n: 1,
            startedAt: NOW - 60_000,
            endedAt: NOW - 30_000,
            outcome: "completed",
            target: "claude/opus",
            usage: { totalCostUsd: 0.25, inputTokens: 120, outputTokens: 3000 },
          },
        ],
        outputs: { plan: "line one\nline two\n" },
      },
      {
        id: "ship",
        title: "Ship",
        kind: "script",
        status: "running",
        attemptCount: 0,
        startedAt: NOW - 20_000,
        attempts: [],
      },
    ],
    history: [
      { at: NOW - 120_000, seq: 1, type: "run_started", stepId: null, attempt: null, detail: "release" },
      { at: NOW - 60_000, seq: 2, type: "dispatch", stepId: "build", attempt: 1, detail: null },
      { at: NOW - 30_000, seq: 3, type: "settle", stepId: "build", attempt: 1, detail: "success" },
    ],
    gates: [gate()],
  });
}

describe("labels and filters", () => {
  it("maps every run and step status to a label, a tone and a glyph", () => {
    expect(RUN_STATUS_LABELS.waiting).toBe("Waiting for gate");
    expect(STEP_STATUS_LABELS.ready).toBe("Ready");
    expect(runStatusTone("completed")).toBe("success");
    expect(runStatusTone("failed")).toBe("danger");
    expect(runStatusTone("running")).toBe("accent");
    expect(runStatusTone("waiting")).toBe("warning");
    expect(runStatusTone("cancelled")).toBe("neutral");
  });

  it("treats a cancelled run as failed for the filter", () => {
    expect(RUN_FILTERS).toEqual(["all", "running", "failed", "completed"]);
    expect(runMatchesFilter("cancelled", "failed")).toBe(true);
    expect(runMatchesFilter("waiting", "running")).toBe(true);
    expect(runMatchesFilter("pending", "running")).toBe(true);
    expect(runMatchesFilter("completed", "running")).toBe(false);
  });
});

describe("history text", () => {
  it("renders every declared event type without falling through", () => {
    const texts = HISTORY_EVENT_TYPES.map((type) =>
      historyText({
        at: NOW,
        seq: 1,
        type,
        stepId: null,
        attempt: null,
        detail: "d",
      } as HistoryEvent),
    );
    expect(texts).toHaveLength(HISTORY_EVENT_TYPES.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(texts[0]).toContain("d");
  });
});

describe("the step log", () => {
  it("orders attempts, outputs, outcome and gates into one log", () => {
    const run = detail();
    const step = run.steps[0] as StepSummary;
    const entries = buildStepLog({
      step,
      history: run.history,
      gates: run.gates,
      attempts: [
        {
          n: 1,
          startedAt: NOW - 60_000,
          endedAt: NOW - 30_000,
          durationLabel: "30s",
          target: "claude/opus",
          outcome: "completed",
          usageLabel: "$0.25",
          running: false,
        },
      ],
      outputs: [{ name: "plan", value: "line one\nline two", lines: ["line one", "line two"] }],
      outcome: "success",
    });
    const texts = entries.map((entry) => entry.text);
    expect(texts).toContain("Dispatched (attempt 1)");
    expect(texts).toContain("Settled: success");
    expect(texts).toContain("Attempt 1 started on claude/opus");
    expect(texts).toContain("Attempt 1 completed in 30s");
    expect(texts).toContain("Usage: $0.25");
    expect(texts).toContain("Output plan:");
    expect(texts).toContain("line one");
    expect(texts).toContain("line two");
    expect(texts).toContain("Outcome: success");
    // Attempt start precedes its completion, and continuation lines carry no timestamp.
    expect(texts.indexOf("Attempt 1 started on claude/opus")).toBeLessThan(
      texts.indexOf("Attempt 1 completed in 30s"),
    );
    expect(entries.find((entry) => entry.text === "line one")?.at).toBeNull();
    expect(logText(entries).split("\n")[0]).toMatch(/^\d{2}:\d{2}:\d{2}  /);
  });

  it("builds a run log from run-level events only", () => {
    const entries = buildRunLog(detail().history);
    expect(entries.map((entry) => entry.text)).toEqual(["Run started: release"]);
  });

  it("compacts usage and formats numbers", () => {
    expect(compactUsage({ totalCostUsd: 0.25 })).toBe("$0.25");
    expect(compactUsage({ inputTokens: 1200, outputTokens: 3_000_000 })).toBe("1.2k in · 3M out");
    expect(compactUsage({})).toBeNull();
    expect(formatTokens(999)).toBe("999");
    expect(formatDuration(62_000)).toBe("1m 2s");
    expect(formatRelative(NOW - 120_000, NOW)).toBe("2m ago");
    expect(shortId("01J0000000000000000000000A")).toBe("01J00000");
  });
});

describe("gate views", () => {
  it("maps choices to tones and exposes the comment requirement", () => {
    const view = gateView(gate(), { deciding: true });
    expect(view.key).toBe("01J0000000000000000000000A.ship:1");
    expect(view.deciding).toBe(true);
    expect(view.choices).toEqual([
      { id: "approve", label: "Approve", comment: "optional", tone: "success" },
      { id: "reject", label: "Reject", comment: "required", tone: "danger" },
    ]);
  });
});

describe("run views", () => {
  it("projects a summary into the CI-shaped row", () => {
    const view = runView(summary(), { now: NOW });
    expect(view.runIdShort).toBe("01J00000");
    expect(view.statusLabel).toBe("Running");
    expect(view.tone).toBe("accent");
    expect(view.triggerLabel).toBe("manual");
    expect(view.detail).toBe("1/2 steps · Ship running");
    expect(view.progress.map((step) => step.status)).toEqual(["completed", "running"]);
    expect(view.costLabel).toBe("$0.25");
    expect(view.removable).toBe(false);
  });

  it("uses the detail projection when it belongs to the same run", () => {
    const view = runView(summary(), { detail: detail(), now: NOW });
    expect(view.steps[0]?.log.some((entry) => entry.text === "Dispatched (attempt 1)")).toBe(true);
    expect(view.steps[0]?.hasLog).toBe(true);
  });

  it("freezes a terminal run's elapsed time but advances a live one", () => {
    const done = summary({ status: "completed" });
    const first = runView(done, { now: NOW });
    const muchLater = runView(done, { now: NOW + 3_600_000 });
    expect(muchLater.durationLabel).toBe(first.durationLabel);

    const live = runView(summary(), { now: NOW });
    const liveLater = runView(summary(), { now: NOW + 60_000 });
    expect(liveLater.durationLabel).not.toBe(live.durationLabel);
  });

  it("carries fork provenance for the run header", () => {
    const view = runView(
      summary({
        forkedFrom: {
          runId: "01J0000000000000000000000B",
          stepId: "ship",
          fromHash: "a",
          toHash: "b",
        },
      }),
      { now: NOW },
    );
    expect(view.forkedFrom).toEqual({
      runId: "01J0000000000000000000000B",
      stepId: "ship",
    });
  });

  it("groups by playbook, newest group first, and sorts runs", () => {
    const first = runView(summary(), { now: NOW });
    const second = runView(
      summary({ id: "01J0000000000000000000000B", updatedAt: NOW - 1, seq: 9 }),
      { now: NOW },
    );
    const other = runView(
      summary({ id: "01J0000000000000000000000C", playbookId: "docs", updatedAt: NOW - 90_000 }),
      { now: NOW },
    );
    const groups = groupRuns([first, other, second]);
    expect(groups.map((group) => group.playbookId)).toEqual(["release", "docs"]);
    expect(groups[0]?.total).toBe(2);
    expect(sortRuns([summary({ id: "a", updatedAt: 1 }), summary({ id: "b", updatedAt: 2 })])[0]?.id).toBe("b");
  });

  it("counts pending gates and maps the panel view", () => {
    const run = summary();
    expect(pendingGates([run])).toEqual([]);
    const view = panelView(
      {
        runs: [run],
        gates: [gate()],
        inFlight: [],
        busyRuns: [],
        detail: detail(),
        selectedRunId: run.id,
        detailLoading: false,
        filter: "all",
        loading: false,
        connected: true,
        error: null,
      },
      { now: NOW },
    );
    expect(view.heading).toBe("1 run · 1 running · 1 gate");
    expect(view.filters.map((filter) => filter.count)).toEqual([1, 1, 0, 0]);
    expect(view.groups).toHaveLength(1);
    expect(view.selected?.run.id).toBe(run.id);
    expect(view.selected?.runLog).toHaveLength(1);
    expect(view.pendingGates).toBe(1);
    expect(view.statusLabel).toBe("Live");
    expect(view.statusTone).toBe("success");
    expect(view.empty).toBe(false);
  });
});

describe("start form", () => {
  it("accepts key=value lines and JSON objects", () => {
    const lines = parseStartForm({ playbookId: " release ", cwd: " /repo ", inputs: "a=1\nb = two " });
    expect(lines).toEqual({
      ok: true,
      request: { playbookId: "release", cwd: "/repo", inputs: { a: "1", b: "two" } },
    });
    const json = parseStartForm({ playbookId: "release", cwd: "", inputs: '{"n": 42, "ok": true}' });
    expect(json).toEqual({
      ok: true,
      request: { playbookId: "release", inputs: { n: 42, ok: true } },
    });
  });

  it("refuses malformed forms with invalid_request", () => {
    for (const form of [
      { playbookId: " ", cwd: "", inputs: "" },
      { playbookId: "x", cwd: "", inputs: "{oops" },
      { playbookId: "x", cwd: "", inputs: "[1,2]" },
      { playbookId: "x", cwd: "", inputs: '{"a": {}}' },
      { playbookId: "x", cwd: "", inputs: "=no-key" },
    ]) {
      const result = parseStartForm(form);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_request");
    }
  });
});
