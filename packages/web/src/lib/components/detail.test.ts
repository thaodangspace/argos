// @vitest-environment jsdom
/**
 * The run page surface (spec FR9/FR10): header, step rail, step log with attempts/outputs, and the
 * run log. Views come from the shared model, so this test only proves the rendering.
 */

import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { RunDetail } from "@thaodangspace/argos-core/rpc/contracts";
import { buildRunLog, runView } from "@thaodangspace/argos-core/view";

import RunHeader from "./RunHeader.svelte";
import RunLog from "./RunLog.svelte";
import StepLog from "./StepLog.svelte";
import StepRail from "./StepRail.svelte";
import ViewToggle from "./ViewToggle.svelte";

const NOW = 1_700_000_100_000;

const detail: RunDetail = {
  id: "01J0000000000000000000000A",
  playbookId: "release",
  playbookHash: "h",
  status: "failed",
  inputs: {},
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
      outcome: "success",
      attempts: [
        {
          n: 1,
          startedAt: NOW - 60_000,
          endedAt: NOW - 30_000,
          outcome: "completed",
          target: "claude/opus",
          usage: { totalCostUsd: 0.25 },
        },
      ],
      outputs: { plan: "line one\nline two" },
    },
    {
      id: "ship",
      title: "Ship",
      kind: "script",
      status: "failed",
      attemptCount: 1,
      startedAt: NOW - 20_000,
      endedAt: NOW - 10_000,
      errorCode: "step_failed",
      outcome: "failed",
      attempts: [
        {
          n: 1,
          startedAt: NOW - 20_000,
          endedAt: NOW - 10_000,
          outcome: "failed",
          errorCode: "step_failed",
        },
      ],
    },
  ],
  gates: [],
  after: [],
  history: [
    { at: NOW - 120_000, seq: 1, type: "run_started", stepId: null, attempt: null, detail: "release" },
    { at: NOW - 60_000, seq: 2, type: "dispatch", stepId: "build", attempt: 1, detail: null },
    { at: NOW - 30_000, seq: 3, type: "settle", stepId: "build", attempt: 1, detail: "success" },
    { at: NOW - 10_000, seq: 4, type: "task_error", stepId: "ship", attempt: 1, detail: "boom" },
  ],
  createdAt: NOW - 120_000,
  updatedAt: NOW - 10_000,
  seq: 4,
};

describe("RunHeader", () => {
  it("shows identity, status, trigger, executor, cwd and usage", () => {
    const withMeta: RunDetail = { ...detail, executor: "hc", usage: { totalCostUsd: 0.5 } };
    const view = runView(withMeta, { detail: withMeta, now: NOW });
    render(RunHeader, { props: { run: view } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("release");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("#01J00000");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("manual")).toBeTruthy();
    expect(screen.getByText("hc")).toBeTruthy();
    expect(screen.getByText("/repo")).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
  });

  it("shows fork provenance and the run inputs", () => {
    const forked: RunDetail = {
      ...detail,
      forkedFrom: {
        runId: "01J0000000000000000000000B",
        stepId: "ship",
        fromHash: "a",
        toHash: "b",
      },
      inputs: { version: "4.0.0" },
    };
    render(RunHeader, { props: { run: runView(forked, { detail: forked, now: NOW }) } });
    expect(screen.getByText(/forked from #01J00000 @ ship/)).toBeTruthy();
    expect(screen.getByText("version=4.0.0")).toBeTruthy();
  });
});

describe("StepRail", () => {
  it("renders every step, marks the selection, and reports a click", async () => {
    const view = runView(detail, { detail, now: NOW });
    const onSelect = vi.fn();
    render(StepRail, { props: { steps: view.steps, selectedId: "build", onSelect } });
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByText("agent").length).toBeGreaterThan(0);
    await fireEvent.click(buttons[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("ship");
  });
});

describe("ViewToggle", () => {
  it("renders Rail | Graph and disables the graph half without a graph", () => {
    // This detail predates the graph field, exactly what an older server sends (FR22).
    expect(detail.graph).toBeUndefined();
    render(ViewToggle, {
      props: { view: "rail", graphAvailable: detail.graph !== undefined, onView: vi.fn() },
    });

    expect(screen.getByRole("button", { name: "Rail" })).toBeTruthy();
    const graphButton = screen.getByRole("button", { name: "Graph" }) as HTMLButtonElement;
    expect(graphButton.disabled).toBe(true);
    expect(graphButton.getAttribute("title")).toBe("graph unavailable");
  });
});

describe("StepLog", () => {
  it("renders attempts, outputs and log lines", () => {
    const view = runView(detail, { detail, now: NOW });
    const build = view.steps[0];
    expect(build).toBeDefined();
    if (build === undefined) return;
    render(StepLog, { props: { step: build } });
    expect(screen.getByRole("heading", { name: "Build" })).toBeTruthy();
    expect(screen.getByText("claude/opus")).toBeTruthy();
    expect(screen.getByText("$0.25")).toBeTruthy();
    expect(screen.getByText("plan")).toBeTruthy();
    expect(screen.getAllByText(/line one/).length).toBeGreaterThan(0);
    expect(screen.getByText("Attempt 1 started on claude/opus")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy step log" })).toBeTruthy();
  });

  it("renders the failure and its error code", () => {
    const view = runView(detail, { detail, now: NOW });
    const ship = view.steps[1];
    if (ship === undefined) return;
    render(StepLog, { props: { step: ship } });
    expect(screen.getByText("step_failed")).toBeTruthy();
    expect(screen.getByText("Error: step_failed")).toBeTruthy();
  });
});

describe("RunLog", () => {
  it("renders run-level lines only", () => {
    const entries = buildRunLog(detail.history);
    render(RunLog, { props: { entries } });
    expect(screen.getByRole("heading", { name: "Run log" })).toBeTruthy();
    expect(screen.getByText("Run started: release")).toBeTruthy();
    // A step-level event is not part of the run log.
    expect(screen.queryByText(/Dispatched/)).toBeNull();
  });
});
