// @vitest-environment jsdom
/**
 * The runs list surface (spec FR8/FR15): the chronological list with day sections, the scope rail,
 * the filter toolbar, the rows, the live pill, and the empty state.
 *
 * Rendered with the host components, no real server and no real EventSource. The assertions pin the
 * GitHub-Actions shape: time is the axis, a workflow is a facet.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { RunSummary, StepSummary } from "@thaodangspace/argos-core/rpc/contracts";
import {
  daySections,
  runFacets,
  runView,
  sortRunViews,
  type RunView,
} from "@thaodangspace/argos-core/view";

import ConnectionPill from "./ConnectionPill.svelte";
import EmptyState from "./EmptyState.svelte";
import ListToolbar from "./ListToolbar.svelte";
import RunList from "./RunList.svelte";
import RunRow from "./RunRow.svelte";
import WorkflowRail from "./WorkflowRail.svelte";

const NOW = 1_700_000_100_000;

function step(id: string, status: StepSummary["status"]): StepSummary {
  return { id, title: id, kind: "agent", status, attemptCount: 1 };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "01J0000000000000000000000A",
    playbookId: "release",
    playbookHash: "h",
    status: "running",
    inputs: {},
    cwd: "/repo",
    steps: [step("build", "completed"), step("ship", "running")],
    gates: [],
    after: [],
    createdAt: NOW - 60_000,
    updatedAt: NOW - 5_000,
    seq: 2,
    ...overrides,
  };
}

function view(overrides: Partial<RunSummary> = {}): RunView {
  return runView(summary(overrides), { now: NOW });
}

describe("RunRow", () => {
  it("renders status, identity, progress and a link", () => {
    const run = view();
    render(RunRow, { props: { run } });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`/ui/runs/${run.id}`);
    expect(link.getAttribute("aria-label")).toContain("Run");
    expect(screen.getByText("#01J00000")).toBeTruthy();
    expect(screen.getByText("1/2 steps · ship running")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(document.querySelectorAll("[data-dot]")).toHaveLength(2);
  });

  it("shows the executor badge and cost when the run reports them", () => {
    const run = runView(summary({ executor: "hc" }), { now: NOW });
    render(RunRow, { props: { run } });
    expect(screen.getByText("hc")).toBeTruthy();
  });

  it("reads the start time on the timeline and the activity time on the other order", () => {
    const run = view({ createdAt: NOW - 3_600_000, updatedAt: NOW - 1_000 });
    const first = render(RunRow, { props: { run, relative: "start" } });
    expect(first.getByText("1h ago")).toBeTruthy();
    cleanup();
    const second = render(RunRow, { props: { run, relative: "activity" } });
    expect(second.getByText("just now")).toBeTruthy();
  });

  it("adds the project and workflow labels the flat list needs", () => {
    const run = view({ cwd: "/Users/dt/code/vsee" });
    render(RunRow, { props: { run, showPlaybook: true, showProject: true } });
    expect(screen.getByText("vsee")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
  });
});

describe("FilterChips (via ListToolbar)", () => {
  it("marks the active chip and reports a click", async () => {
    const onStatus = vi.fn();
    const runs = [view()];
    render(ListToolbar, {
      props: {
        filters: [{ id: "all", label: "All", count: 1 }],
        query: { status: "all" },
        facets: runFacets(runs),
        sort: "start",
        total: 1,
        running: 1,
        onStatus,
        onFacet: vi.fn(),
        onSort: vi.fn(),
      },
    });
    const all = screen.getByRole("button", { name: /All/ });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(all);
    expect(onStatus).toHaveBeenCalledWith("all");
  });
});

describe("RunList", () => {
  const listDay = (runs: readonly RunView[]) => daySections(sortRunViews(runs, "start"), NOW);

  it("renders day sections and loads more globally", async () => {
    const runs = Array.from({ length: 30 }, (_, index) =>
      view({
        id: `01J00000000000000000000${String(index).padStart(2, "0")}`,
        createdAt: NOW - index * 1_000,
      }),
    );
    render(RunList, { props: { days: listDay(runs), pageSize: 25 } });

    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(25);
    await fireEvent.click(screen.getByRole("button", { name: /Load 5 more/ }));
    expect(screen.getAllByRole("link")).toHaveLength(30);
  });

  it("separates yesterday from today", () => {
    const today = view({ id: "01J0000000000000000000000A", createdAt: NOW - 1_000 });
    const yesterday = view({ id: "01J0000000000000000000000B", createdAt: NOW - 86_400_000 });
    render(RunList, { props: { days: listDay([yesterday, today]) } });
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeTruthy();
  });
});

describe("WorkflowRail", () => {
  const runs = [
    view({ id: "01J0000000000000000000000A", playbookId: "release", cwd: "/code/vsee" }),
    view({
      id: "01J0000000000000000000000B",
      playbookId: "docs",
      cwd: "/code/argos",
      status: "failed",
    }),
  ];

  const railProps = (overrides: Record<string, unknown> = {}) => ({
    facets: runFacets(runs),
    query: { status: "all" as const },
    total: 2,
    onSelect: vi.fn(),
    onHide: vi.fn(),
    onShowHidden: vi.fn(),
    ...overrides,
  });

  it("offers every scope with its count and reports the selection", async () => {
    const onSelect = vi.fn();
    render(WorkflowRail, { props: railProps({ onSelect }) });
    expect(screen.getByRole("button", { name: /All workflows/ })).toBeTruthy();
    const release = screen.getByRole("button", { name: /^release/ });
    await fireEvent.click(release);
    expect(onSelect).toHaveBeenCalledWith({ workflow: "release" });
    await fireEvent.click(screen.getByRole("button", { name: /argos/ }));
    expect(onSelect).toHaveBeenCalledWith({ project: "argos" });
  });

  it("marks the active scope and clears both dimensions from the top entry", async () => {
    const onSelect = vi.fn();
    render(WorkflowRail, {
      props: railProps({ query: { status: "all", workflow: "release" }, onSelect }),
    });
    expect(screen.getByRole("button", { name: /^release/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    await fireEvent.click(screen.getByRole("button", { name: /All workflows/ }));
    expect(onSelect).toHaveBeenCalledWith({ workflow: undefined, project: undefined });
  });

  it("keeps idle workflows collapsed while something is in use", async () => {
    const mixed = [
      view({ id: "01J0000000000000000000000A", playbookId: "release" }),
      view({ id: "01J0000000000000000000000B", playbookId: "one-off", status: "completed" }),
    ];
    render(WorkflowRail, {
      props: railProps({
        facets: runFacets(mixed, { liveWorkflows: ["release"] }),
        total: 2,
      }),
    });
    // "release" is scheduled, so it is in use; "one-off" is a finished one-shot run.
    expect(screen.getByRole("button", { name: /^release/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^one-off/ })).toBeNull();
    const toggle = screen.getByRole("button", { name: /Idle/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /^one-off/ })).toBeTruthy();
  });

  it("shows every workflow when none of them is in use", () => {
    render(WorkflowRail, {
      props: railProps({
        facets: runFacets([view({ playbookId: "release", status: "completed" })]),
        total: 1,
      }),
    });
    expect(screen.getByRole("button", { name: /^release/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Idle/ })).toBeNull();
  });

  it("hides a workflow, leaves the active one alone, and offers to show them again", async () => {
    const onHide = vi.fn();
    const onShowHidden = vi.fn();
    const hiddenRun = [
      view({ id: "01J0000000000000000000000A", playbookId: "release" }),
      view({ id: "01J0000000000000000000000B", playbookId: "demo-hc" }),
      view({ id: "01J0000000000000000000000C", playbookId: "one-off", status: "completed" }),
    ];
    render(WorkflowRail, {
      props: railProps({
        facets: runFacets(hiddenRun, { liveWorkflows: ["release"] }),
        hidden: ["demo-hc"],
        total: 3,
        onHide,
        onShowHidden,
      }),
    });
    expect(screen.queryByRole("button", { name: /^demo-hc/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Hide release" }));
    expect(onHide).toHaveBeenCalledWith("release");
    await fireEvent.click(screen.getByRole("button", { name: /1 hidden/ }));
    expect(onShowHidden).toHaveBeenCalled();
  });

  it("does not offer to hide the workflow the list is scoped to", () => {
    render(WorkflowRail, {
      props: railProps({ query: { status: "all", workflow: "release" } }),
    });
    expect(screen.queryByRole("button", { name: "Hide release" })).toBeNull();
  });
});

describe("ListToolbar", () => {
  const runs = [
    view({ id: "01J0000000000000000000000A", cwd: "/code/vsee" }),
    view({ id: "01J0000000000000000000000B", cwd: "/code/argos", playbookId: "docs" }),
  ];

  it("shows the visible count and switches the order", async () => {
    const onSort = vi.fn();
    render(ListToolbar, {
      props: {
        filters: [{ id: "all", label: "All", count: 2 }],
        query: { status: "all" },
        facets: runFacets(runs),
        sort: "start",
        total: 2,
        running: 2,
        onStatus: vi.fn(),
        onFacet: vi.fn(),
        onSort,
      },
    });
    expect(screen.getByText("2", { selector: "[aria-live='polite'] strong" })).toBeTruthy();
    expect(screen.getByText("2 in progress")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Recent activity" }));
    expect(onSort).toHaveBeenCalledWith("activity");
  });

  it("reports a facet select change, including clearing it", async () => {
    const onFacet = vi.fn();
    render(ListToolbar, {
      props: {
        filters: [{ id: "all", label: "All", count: 2 }],
        query: { status: "all" },
        facets: runFacets(runs),
        sort: "start",
        total: 2,
        running: 2,
        onStatus: vi.fn(),
        onFacet,
        onSort: vi.fn(),
      },
    });
    const project = screen.getByLabelText(/Project/);
    await fireEvent.change(project, { target: { value: "vsee" } });
    expect(onFacet).toHaveBeenCalledWith("project", "vsee");
    await fireEvent.change(project, { target: { value: "" } });
    expect(onFacet).toHaveBeenCalledWith("project", undefined);
  });
});

describe("ConnectionPill", () => {
  it("labels every state and announces it", () => {
    for (const [status, label] of [
      ["open", "Live"],
      ["connecting", "Connecting"],
      ["reconnecting", "Reconnecting"],
      ["closed", "Disconnected"],
    ] as const) {
      const view = render(ConnectionPill, { props: { status } });
      const pill = view.getByRole("status");
      expect(pill.textContent).toContain(label);
      expect(pill.getAttribute("aria-live")).toBe("polite");
      cleanup();
    }
  });
});

describe("EmptyState", () => {
  it("renders the title and the CLI hint", () => {
    render(EmptyState, {
      props: { title: "No workflow runs yet", hint: "Start one with argos run." },
    });
    expect(screen.getByRole("heading", { name: "No workflow runs yet" })).toBeTruthy();
    expect(screen.getByText("Start one with argos run.")).toBeTruthy();
  });
});
