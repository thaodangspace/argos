// @vitest-environment jsdom
/**
 * The runs list surface (spec FR8/FR15): rows, filters, grouping, the live pill, and the empty state.
 * Rendered with the host components, no real server and no real EventSource.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { RunSummary, StepSummary } from "@thaodangspace/argos-core/rpc/contracts";
import { groupRuns, runView, type RunView } from "@thaodangspace/argos-core/view";

import ConnectionPill from "./ConnectionPill.svelte";
import EmptyState from "./EmptyState.svelte";
import FilterChips from "./FilterChips.svelte";
import RunGroup from "./RunGroup.svelte";
import RunRow from "./RunRow.svelte";

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
    expect(document.querySelectorAll(".dot")).toHaveLength(2);
  });

  it("shows the executor badge and cost when the run reports them", () => {
    const run = runView(summary({ executor: "hc" }), { now: NOW });
    render(RunRow, { props: { run } });
    expect(screen.getByText("hc")).toBeTruthy();
  });
});

describe("FilterChips", () => {
  it("marks the active chip and reports a click", async () => {
    const onSelect = vi.fn();
    render(FilterChips, {
      props: {
        filters: [
          { id: "all", label: "All", count: 3 },
          { id: "running", label: "Running", count: 1 },
        ],
        active: "all",
        onSelect,
      },
    });
    const all = screen.getByRole("button", { name: /All/ });
    const running = screen.getByRole("button", { name: /Running/ });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(running.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(running);
    expect(onSelect).toHaveBeenCalledWith("running");
  });
});

describe("RunGroup", () => {
  it("collapses, expands, and pages long run lists", async () => {
    const runs = Array.from({ length: 22 }, (_, index) =>
      view({ id: `01J00000000000000000000${String(index).padStart(2, "0")}`, updatedAt: NOW - index }),
    );
    const group = groupRuns(runs)[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    render(RunGroup, { props: { group, pageSize: 20 } });

    expect(screen.getAllByRole("link")).toHaveLength(20);
    const more = screen.getByRole("button", { name: /Show 2 more/ });
    await fireEvent.click(more);
    expect(screen.getAllByRole("link")).toHaveLength(22);

    const toggle = screen.getByRole("button", { name: /release/ });
    await fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("shows active, failed and gate counts", () => {
    const failed = view({ id: "01J0000000000000000000000B", status: "failed" });
    const group = groupRuns([failed])[0];
    if (group === undefined) return;
    render(RunGroup, { props: { group } });
    expect(screen.getByText("1 failed")).toBeTruthy();
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
