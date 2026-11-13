/**
 * Run-page model tests: the CI-style grouping/filters, the step log built from the detail
 * projection (attempts, declared outputs, history, gates), and the one-fetch selection sync.
 */

import { describe, expect, it, vi } from "vitest";

import type { RunDetail, StepDetailSummary } from "@thaodangspace/argos-core/rpc/contracts";

import {
  buildRunLog,
  buildStepLog,
  createPanel,
  groupRuns,
  logText,
  panelView,
  runMatchesFilter,
  runView,
} from "../shared/panel";
import {
  formatClock,
  formatDuration,
  formatRelative,
  formatTokens,
  formatUsage,
  shortId,
} from "../shared/format";
import { fakeRpc, fakeStream, makeGate, makeRun, makeStep } from "./support.js";

function detailStep(overrides: Partial<StepDetailSummary> & { id: string }): StepDetailSummary {
  return {
    title: overrides.id,
    kind: "script",
    status: "completed",
    attemptCount: 1,
    attempts: [],
    ...overrides,
  };
}

const HISTORY: RunDetail["history"] = [
  { at: 1_000, seq: 0, type: "run_started", stepId: null, attempt: null, detail: "demo" },
  { at: 1_500, seq: 1, type: "dispatch", stepId: "pick", attempt: 1, detail: null },
  { at: 2_000, seq: 2, type: "settle", stepId: null, attempt: null, detail: "1 step(s) settled" },
];

const DETAIL_STEPS: StepDetailSummary[] = [
  detailStep({
    id: "pick",
    title: "Chọn spec",
    status: "completed",
    startedAt: 1_500,
    endedAt: 2_500,
    attemptCount: 1,
    outcome: "success",
    attempts: [
      {
        n: 1,
        startedAt: 1_500,
        endedAt: 2_500,
        outcome: "completed",
        target: "claude/opus",
        usage: { inputTokens: 120, outputTokens: 3_000, totalCostUsd: 0.42 },
      },
    ],
    outputs: { stdout: "specs/VP-7.md\n" },
  }),
  detailStep({
    id: "ship",
    title: "Ship",
    kind: "agent",
    status: "failed",
    attemptCount: 1,
    startedAt: 2_500,
    endedAt: 4_500,
    errorCode: "step_timeout",
    attempts: [{ n: 1, startedAt: 2_500, endedAt: 4_500, outcome: "timeout" }],
  }),
];

function detailRun(): RunDetail {
  return {
    ...makeRun({
      id: "run-1",
      playbookId: "va-spec-impl",
      status: "failed",
      createdAt: 1_000,
      updatedAt: 4_500,
      steps: DETAIL_STEPS,
    }),
    steps: DETAIL_STEPS,
    history: HISTORY,
  };
}

describe("step log", () => {
  it("renders attempts, usage, outputs, outcome, and history in time order", () => {
    const detail = detailRun();
    const step = detail.steps[0] as StepDetailSummary;
    const entries = buildStepLog({
      step,
      history: detail.history,
      gates: [],
      attempts: runView(detail, { now: 5_000 }).steps[0]?.attempts ?? [],
      outputs: runView(detail, { now: 5_000 }).steps[0]?.outputs ?? [],
      ...(step.outcome === undefined ? {} : { outcome: step.outcome }),
    });
    expect(entries.map((entry) => entry.text)).toEqual([
      "Dispatched (attempt 1)",
      "Attempt 1 started on claude/opus",
      "Attempt 1 completed in 1s",
      "Usage: $0.42 · 120 in · 3k out",
      "Output stdout:",
      "specs/VP-7.md",
      "Outcome: success",
    ]);
    expect(entries[0]?.timeLabel).toBe("00:00:01");
    // The output's second line continues without a timestamp.
    expect(entries[5]?.timeLabel).toBe("");

    const text = logText(entries);
    expect(text.split("\n")[0]).toBe("00:00:01  Dispatched (attempt 1)");
    expect(text).toContain("00:00:02  Attempt 1 completed in 1s");
  });

  it("adds gate lines and an error line for a failed step", () => {
    const detail = detailRun();
    const view = runView(detail, { now: 5_000 });
    const ship = view.steps[1];
    expect(ship?.errorCode).toBe("step_timeout");
    expect(ship?.log.map((entry) => entry.text)).toContain("Attempt 1 timed out in 2s");
    expect(ship?.log.map((entry) => entry.text)).toContain("Error: step_timeout");
    expect(ship?.retryable).toBe(true);
    expect(ship?.hasLog).toBe(true);
  });

  it("keeps a pending step's log empty and exposes the copyable text", () => {
    const view = runView(makeRun({ id: "run-2", status: "running" }));
    expect(view.steps[0]?.attempts).toEqual([]);
    expect(view.steps[0]?.log).toEqual([]);
    expect(view.steps[0]?.hasLog).toBe(false);
    expect(view.steps[0]?.logText).toBe("");
  });

  it("builds the run-level log without step events", () => {
    expect(buildRunLog(HISTORY).map((entry) => entry.text)).toEqual([
      "Run started: demo",
      "Settled: 1 step(s) settled",
    ]);
  });

  it("shows a script failure detail and a decided gate on the step", () => {
    const detail: RunDetail = {
      ...detailRun(),
      gates: [
        makeGate({
          gateId: "pick:1",
          stepId: "pick",
          status: "decided",
          decision: "approve",
          decidedBy: "dt",
          decidedVia: "cli",
          decidedAt: 3_000,
        }),
      ],
    };
    const pick = runView(detail, { now: 5_000 }).steps[0];
    expect(pick?.gates.map((gate) => gate.gateId)).toEqual(["pick:1"]);
    const texts = pick?.log.map((entry) => entry.text) ?? [];
    expect(texts.some((text) => text.startsWith("Gate pick:1 (step) decided"))).toBe(true);
    expect(texts).toContain("Decision: approve by dt via cli");
  });
});

describe("grouping and filters", () => {
  const views = [
    runView(
      makeRun({
        id: "run-a",
        playbookId: "hourly",
        status: "running",
        updatedAt: 5_000,
      }),
      { now: 5_000 },
    ),
    runView(
      makeRun({ id: "run-b", playbookId: "hourly", status: "failed", updatedAt: 4_000 }),
      { now: 5_000 },
    ),
    runView(
      makeRun({ id: "run-c", playbookId: "nightly", status: "completed", updatedAt: 9_000 }),
      { now: 5_000 },
    ),
  ];

  it("groups by playbook, newest group first, and counts active/failed runs", () => {
    const groups = groupRuns(views);
    expect(groups.map((group) => group.playbookId)).toEqual(["nightly", "hourly"]);
    const hourly = groups[1];
    expect(hourly?.total).toBe(2);
    expect(hourly?.active).toBe(1);
    expect(hourly?.failed).toBe(1);
    expect(hourly?.latest.id).toBe("run-a");
    expect(hourly?.runs.map((run) => run.id)).toEqual(["run-a", "run-b"]);
  });

  it("maps the filter to run statuses", () => {
    expect(runMatchesFilter("running", "running")).toBe(true);
    expect(runMatchesFilter("waiting", "running")).toBe(true);
    expect(runMatchesFilter("cancelled", "failed")).toBe(true);
    expect(runMatchesFilter("completed", "failed")).toBe(false);
    expect(runMatchesFilter("completed", "all")).toBe(true);
  });
});

describe("selection", () => {
  it("fetches the detail once, keeps it across an unchanged poll, and refreshes on a move", async () => {
    const run = makeRun({ id: "run-1", status: "running", seq: 1 });
    const detail = { ...makeRun({ ...run }), steps: DETAIL_STEPS, history: HISTORY };
    const client = fakeRpc({ runs: [run], detail });
    const stream = fakeStream();
    const panel = createPanel({ client, openEvents: stream.openEvents });
    panel.start();
    stream.push("snapshot", { runs: [run] });

    const opened = await panel.selectRun("run-1");
    expect(client.getRun).toHaveBeenCalledTimes(1);
    expect(opened.selectedRunId).toBe("run-1");
    expect(opened.detail?.id).toBe("run-1");
    expect(opened.detailLoading).toBe(false);
    const view = panelView(opened, { now: 5_000 });
    expect(view.selected?.run.id).toBe("run-1");
    expect(view.selected?.run.steps[0]?.log.length).toBeGreaterThan(0);
    expect(view.selected?.runLog.map((entry) => entry.text)).toEqual([
      "Run started: demo",
      "Settled: 1 step(s) settled",
    ]);

    // A poll with the same seq does not re-fetch.
    stream.push("snapshot", { runs: [{ ...run }] });
    expect(client.getRun).toHaveBeenCalledTimes(1);

    // The run advanced: the open page refreshes itself.
    stream.push("snapshot", { runs: [{ ...run, seq: 2, updatedAt: 3_000 }] });
    await vi.waitFor(() => {
      expect(client.getRun).toHaveBeenCalledTimes(2);
    });

    panel.dispose();
  });

  it("goes back to the list when the open run was removed", async () => {
    const run = makeRun({ id: "run-1", seq: 1 });
    const client = fakeRpc({ runs: [run] });
    const stream = fakeStream();
    const panel = createPanel({ client, openEvents: stream.openEvents });
    panel.start();
    stream.push("snapshot", { runs: [run] });
    await panel.selectRun("run-1");

    const removed = panel.closeRun();
    expect(removed.selectedRunId).toBeNull();
    expect(removed.detail).toBeNull();

    // Re-open, then the server reports the run gone: selection clears instead of a dead page.
    await panel.selectRun("run-1");
    stream.push("snapshot", { runs: [] });
    await vi.waitFor(() => {
      expect(panel.getModel().selectedRunId).toBeNull();
    });
    panel.dispose();
  });

  it("keeps run_unknown as the error and closes the page", async () => {
    const client = fakeRpc({ runs: [] });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });
    const model = await panel.selectRun("nope");
    expect(model.selectedRunId).toBeNull();
    expect(model.error?.code).toBe("run_unknown");
    panel.dispose();
  });

  it("filters the list without touching the open run", async () => {
    const active = makeRun({ id: "run-a", status: "running", updatedAt: 2_000 });
    const failed = makeRun({ id: "run-b", status: "failed", updatedAt: 1_000 });
    const panel = createPanel({ client: fakeRpc({ runs: [active, failed] }) });
    await panel.load();
    const model = panel.setFilter("failed");
    const view = panelView(model, { now: 5_000 });
    expect(view.visibleCount).toBe(1);
    expect(view.groups.map((group) => group.latest.id)).toEqual(["run-b"]);
    expect(view.filters.map((filter) => filter.count)).toEqual([2, 1, 1, 0]);
    panel.dispose();
  });
});

describe("formatting", () => {
  it("formats durations, clocks, and relative times deterministically", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(62_000)).toBe("1m 2s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(-1)).toBe("—");
    expect(formatClock(1_000)).toBe("00:00:01");
    expect(formatClock(null)).toBe("");
    expect(formatRelative(0, 30_000)).toBe("just now");
    expect(formatRelative(0, 180_000)).toBe("3m ago");
    expect(formatRelative(0, 7_200_000)).toBe("2h ago");
    expect(formatRelative(0, 40 * 86_400_000)).toBe("1970-01-01");
  });

  it("formats usage and short ids", () => {
    expect(formatTokens(130)).toBe("130");
    expect(formatTokens(35_982)).toBe("36k");
    expect(formatTokens(6_322_750)).toBe("6.32M");
    expect(formatUsage({ totalCostUsd: 3.017, inputTokens: 130, cachedInputTokens: 6_322_750 })).toBe(
      "$3.02 · 130 in · 6.32M cached",
    );
    expect(formatUsage({ custom: 5 })).toBe("custom=5");
    expect(formatUsage(undefined)).toBeNull();
    expect(shortId("01M798D7E0B4R2HVGYRWJTDMP6")).toBe("01M798D7");
    expect(shortId("run-1")).toBe("run-1");
  });
});
