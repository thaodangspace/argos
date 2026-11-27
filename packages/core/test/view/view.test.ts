/**
 * The shared view model (spec FR6): labels/tones, history text for every event type, the step log,
 * run views and grouping, gate views, the start form, and the formatters.
 *
 * These assertions run against the core subpath, so no client can use an untested copy.
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
  daySections,
  dayKey,
  filterRunViews,
  formatClock,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  gateView,
  groupRuns,
  historyText,
  isTimeZone,
  listTimeZones,
  logText,
  panelView,
  parseStartForm,
  projectOf,
  runFacets,
  runMatchesFilter,
  runStatusTone,
  runView,
  scopeSubtitle,
  scopeTitle,
  shortId,
  sortRunViews,
  sortRuns,
  pendingGates,
  systemTimeZone,
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

describe("timestamps", () => {
  // 2023-11-14T22:15:00Z: the 14th 22:15 in UTC, the 15th 05:15 in Saigon (+07:00).
  const AT = Date.UTC(2023, 10, 14, 22, 15, 0);

  it("renders the reader's zone, and UTC only when it is asked for", () => {
    expect(formatDateTime(AT, "UTC")).toBe("2023-11-14 22:15 UTC");
    expect(formatDateTime(AT, "Asia/Saigon")).toBe("2023-11-15 05:15 +07:00");
    // A northern-hemisphere winter instant carries the DST-correct offset, not the zone's summer one.
    expect(formatDateTime(AT, "America/New_York")).toBe("2023-11-14 17:15 -05:00");
    expect(formatClock(AT, "Asia/Saigon")).toBe("05:15:00");
    expect(formatClock(AT, "UTC")).toBe("22:15:00");
    expect(formatClock(null, "UTC")).toBe("");
    expect(formatDate(AT, "Asia/Saigon")).toBe("2023-11-15");
    // The default is this runtime's zone: the same shape, whatever the machine is set to.
    expect(formatDateTime(AT)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (UTC|[+-]\d{2}:\d{2})$/);
    // The far-away fallback of a relative label is a zone date too.
    expect(formatRelative(AT, AT + 40 * 86_400_000, "UTC")).toBe("2023-11-14");
  });

  it("vets a zone id and falls back instead of throwing", () => {
    expect(isTimeZone("Asia/Saigon")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    // A hand-edited preference must render, never crash a row.
    expect(formatDateTime(AT, "Mars/Olympus_Mons")).toBe(formatDateTime(AT));
    expect(systemTimeZone()).not.toBe("");
    expect(listTimeZones()).toContain("UTC");
    expect(listTimeZones()).toContain("America/New_York");
  });

  it("threads the zone through a run view and its step log", () => {
    const row = runView(summary({ createdAt: AT, updatedAt: AT }), {
      now: AT,
      timeZone: "Asia/Saigon",
    });
    expect(row.createdLabel).toBe("2023-11-15 05:15 +07:00");
    expect(row.updatedLabel).toBe("2023-11-15 05:15 +07:00");

    const detailView = runView(detail(), { now: AT, timeZone: "UTC" });
    const first = detailView.steps[0]?.log[0];
    expect(first?.timeLabel).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const localized = runView(detail(), { now: AT, timeZone: "Asia/Saigon" });
    expect(localized.steps[0]?.log[0]?.timeLabel).not.toBe(first?.timeLabel);

    const runLog = buildRunLog(detail().history, { timeZone: "UTC" });
    expect(runLog[0]?.timeLabel).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("run list model", () => {
  const view = (overrides: Partial<RunSummary> = {}): ReturnType<typeof runView> =>
    runView(summary(overrides), { now: NOW });

  it("derives the project from the last cwd segment", () => {
    expect(projectOf("/Users/dt/code/vsee")).toBe("vsee");
    expect(projectOf("/Users/dt/code/vsee/")).toBe("vsee");
    expect(projectOf("/")).toBe("/");
    expect(projectOf("relative/path")).toBe("path");
    expect(projectOf("C:\\work\\argos")).toBe("argos");
    expect(view({ cwd: "/Users/dt/code/vsee" }).project).toBe("vsee");
  });

  it("carries the start timestamp and the trigger facet", () => {
    const manual = view();
    expect(manual.startedRelative).toBe("2m ago");
    expect(manual.triggerFacet).toBe("manual");
    const scheduled = view({
      trigger: { kind: "schedule", scheduleId: "nightly", fireAt: NOW, reason: "cron" },
    });
    expect(scheduled.triggerFacet).toBe("schedule");
  });

  it("orders by start or by activity", () => {
    const longRunning = view({ id: "a", createdAt: NOW - 3_600_000, updatedAt: NOW - 1_000 });
    const fresh = view({ id: "b", createdAt: NOW - 60_000, updatedAt: NOW - 60_000 });
    expect(sortRunViews([longRunning, fresh], "start").map((run) => run.id)).toEqual(["b", "a"]);
    expect(sortRunViews([longRunning, fresh], "activity").map((run) => run.id)).toEqual(["a", "b"]);
  });

  it("filters by every facet and by status", () => {
    const vsee = view({ id: "a", cwd: "/code/vsee" });
    const argos = view({ id: "b", cwd: "/code/argos", playbookId: "docs", status: "completed" });
    const hc = view({ id: "c", executor: "hc" });
    const runs = [vsee, argos, hc];
    expect(filterRunViews(runs, { status: "all" })).toHaveLength(3);
    expect(filterRunViews(runs, { status: "all", project: "vsee" }).map((r) => r.id)).toEqual([
      "a",
    ]);
    expect(filterRunViews(runs, { status: "all", workflow: "docs" }).map((r) => r.id)).toEqual([
      "b",
    ]);
    expect(filterRunViews(runs, { status: "completed" }).map((r) => r.id)).toEqual(["b"]);
    // An absent `executor` key means `paseo`, so the hc run is the only one that matches.
    expect(filterRunViews(runs, { status: "all", executor: "hc" }).map((r) => r.id)).toEqual([
      "c",
    ]);
  });

  it("counts every facet over all runs, in a declared order", () => {
    const runs = [
      view({ id: "a", cwd: "/code/vsee" }),
      view({ id: "b", cwd: "/code/vsee", playbookId: "docs", status: "failed" }),
      view({
        id: "c",
        cwd: "/code/argos",
        trigger: { kind: "schedule", scheduleId: "nightly", fireAt: NOW, reason: "cron" },
      }),
    ];
    const facets = runFacets(runs);
    expect(facets.workflows.map((entry) => [entry.id, entry.count])).toEqual([
      ["release", 2],
      ["docs", 1],
    ]);
    expect(facets.projects.map((entry) => entry.id)).toEqual(["vsee", "argos"]);
    expect(facets.projects[0]?.active).toBe(1);
    expect(facets.projects[0]?.failed).toBe(1);
    expect(facets.triggers.map((entry) => entry.id)).toEqual(["manual", "schedule"]);
    expect(facets.executors.map((entry) => entry.id)).toEqual(["paseo"]);
  });

  it("marks a facet in use from a live run or an enabled schedule", () => {
    const runs = [
      view({ id: "a", cwd: "/code/vsee", playbookId: "release" }),
      view({ id: "b", cwd: "/code/vsee", playbookId: "nightly", status: "completed" }),
      view({ id: "c", cwd: "/code/argos", playbookId: "one-off", status: "completed" }),
    ];
    const idle = runFacets(runs);
    expect(idle.workflows.find((entry) => entry.id === "release")?.live).toBe(true);
    // A finished one-shot run is not "in use" on its own.
    expect(idle.workflows.find((entry) => entry.id === "one-off")?.live).toBe(false);
    expect(idle.projects.find((entry) => entry.id === "argos")?.live).toBe(false);

    // A sleeping scheduled workflow is still in use, and so is its project.
    const scheduled = runFacets(runs, { liveWorkflows: ["nightly"] });
    expect(scheduled.workflows.find((entry) => entry.id === "nightly")?.live).toBe(true);
    expect(scheduled.projects.find((entry) => entry.id === "vsee")?.live).toBe(true);
    expect(scheduled.projects.find((entry) => entry.id === "argos")?.live).toBe(false);
  });

  it("splits the list into labeled reader-zone days", () => {
    const today = view({ id: "a", createdAt: NOW - 60_000 });
    const yesterday = view({ id: "b", createdAt: NOW - 86_400_000 });
    const older = view({ id: "c", createdAt: NOW - 3 * 86_400_000 });
    const sections = daySections([today, yesterday, older], NOW);
    // "Today"/"Yesterday" are zone independent (exactly 24h apart); an older day keeps its
    // `YYYY-MM-DD` label, whose exact value depends on the zone the reader renders in.
    expect(sections.slice(0, 2).map((section) => section.label)).toEqual(["Today", "Yesterday"]);
    expect(sections[2]?.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sections.map((section) => section.runs.length)).toEqual([1, 1, 1]);
  });

  it("cuts the day sections in the reader's zone, not in UTC", () => {
    // 2023-11-14T22:15Z is still the 14th in UTC and already the 15th in Saigon (+07:00).
    const late = view({ id: "a", createdAt: Date.UTC(2023, 10, 14, 22, 15, 0) });
    const early = view({ id: "b", createdAt: Date.UTC(2023, 10, 15, 1, 0, 0) });
    expect(daySections([late, early], Date.UTC(2023, 10, 15, 2, 0, 0), "UTC")).toHaveLength(2);
    expect(daySections([late, early], Date.UTC(2023, 10, 15, 2, 0, 0), "Asia/Saigon")).toHaveLength(
      1,
    );
    expect(dayKey(Date.UTC(2023, 10, 14, 22, 15, 0), "Asia/Saigon")).toBe("2023-11-15");
    expect(dayKey(Date.UTC(2023, 10, 14, 22, 15, 0), "UTC")).toBe("2023-11-14");
  });

  it("projects the visible timeline into the panel view", () => {
    const first = summary({ id: "01J0000000000000000000000A", createdAt: NOW - 10_000 });
    const second = summary({
      id: "01J0000000000000000000000B",
      status: "completed",
      createdAt: NOW - 120_000,
      updatedAt: NOW - 60_000,
    });
    const model = {
      runs: [first, second],
      gates: [],
      inFlight: [],
      busyRuns: [],
      detail: null,
      selectedRunId: null,
      detailLoading: false,
      filter: "all" as const,
      loading: false,
      connected: true,
      error: null,
    };
    const all = panelView(model, { now: NOW });
    expect(all.list.map((run) => run.id)).toEqual([first.id, second.id]);
    expect(all.query).toEqual({ status: "all" });
    expect(all.sort).toBe("start");
    expect(all.days).toHaveLength(1);
    expect(all.visibleCount).toBe(2);

    const scoped = panelView(
      { ...model, workflow: "release", sort: "activity" },
      { now: NOW },
    );
    expect(scoped.list.map((run) => run.id)).toEqual([first.id, second.id]);
    expect(scoped.groups).toHaveLength(1);
    // The activity order renders one unlabeled section: a day header would be a lie.
    expect(scoped.days.map((section) => section.label)).toEqual([""]);

    // The status chips count inside the scope, not over the whole server.
    const narrowed = panelView({ ...model, workflow: "docs" }, { now: NOW });
    expect(narrowed.filters.map((filter) => filter.count)).toEqual([0, 0, 0, 0]);

    const withSchedule = panelView(
      { ...model, liveWorkflows: ["release"] },
      { now: NOW },
    );
    expect(withSchedule.facets.workflows[0]?.live).toBe(true);

    const missing = panelView({ ...model, workflow: "docs" }, { now: NOW });
    expect(missing.list).toEqual([]);
    expect(missing.visibleCount).toBe(0);
    // The CI grouping is status-only, so it is not emptied by a facet.
    expect(missing.groups).toHaveLength(1);
  });

  it("names the scope for the list header", () => {
    expect(scopeTitle({ status: "all" })).toBe("All workflows");
    expect(scopeTitle({ status: "all", workflow: "release" })).toBe("release");
    expect(scopeTitle({ status: "all", project: "vsee" })).toBe("vsee");
    expect(scopeSubtitle({ status: "all" }, 132)).toBe("132 runs · all workflows, newest start first");
    expect(scopeSubtitle({ status: "all", workflow: "release", project: "vsee" }, 1)).toBe(
      "1 run · release in vsee",
    );
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
