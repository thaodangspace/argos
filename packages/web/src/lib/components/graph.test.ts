// @vitest-environment jsdom
/**
 * The run page's DAG view (spec FR17–FR22): one `<svg>` with one focusable node per step, click and
 * keyboard selection into the same `?step=` log the rail drives, the status tone join, the pending
 * gate ring, the skipped opacity, the >60-node fallback, the disabled toggle, and the view/step
 * round trip in the address bar.
 *
 * Geometry itself is `layerGraph`'s contract (pinned in `packages/core/test/view/graph.test.ts`);
 * this suite only proves the rendering and the URL state.
 */

import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type {
  GateSummary,
  PlaybookGraph,
  RunDetail,
  RunSummary,
  StepSummary,
} from "@thaodangspace/argos-core/rpc/contracts";
import { runView, type StatusTone, type StepView } from "@thaodangspace/argos-core/view";

import RunGraph from "./RunGraph.svelte";
import ViewToggle from "./ViewToggle.svelte";
import { readViewParams, writeViewParams } from "../view-query.js";

const NOW = 1_700_000_100_000;
const RUN_ID = "01J0000000000000000000000A";

const graph: PlaybookGraph = {
  nodes: [
    { id: "plan", title: "Plan the work", kind: "agent" },
    { id: "impl", title: "Implement", kind: "agent" },
    { id: "review", title: "Review the diff", kind: "gate" },
    { id: "@end", title: "end", kind: "end" },
  ],
  edges: [
    { from: "plan", to: "impl", kind: "needs" },
    { from: "impl", to: "review", kind: "needs" },
    { from: "review", to: "impl", kind: "goto", label: "rejected", loop: true, maxLoops: 1 },
    { from: "impl", to: "@end", kind: "end", label: "abandoned" },
  ],
  entry: ["plan"],
  terminals: ["@end"],
};

const gate: GateSummary = {
  runId: RUN_ID,
  gateId: "impl:1",
  stepId: "impl",
  kind: "step",
  question: "Ship it?",
  choices: { approve: { label: "Approve", comment: "optional", color: "success" } },
  status: "pending",
};

const detail: RunDetail = {
  id: RUN_ID,
  playbookId: "release",
  playbookHash: "h",
  status: "running",
  inputs: {},
  cwd: "/repo",
  steps: [
    {
      id: "plan",
      title: "Plan the work",
      kind: "agent",
      status: "completed",
      attemptCount: 1,
      attempts: [{ n: 1, startedAt: NOW - 900, endedAt: NOW - 500, outcome: "completed" }],
    },
    {
      id: "impl",
      title: "Implement",
      kind: "agent",
      status: "running",
      attemptCount: 1,
      attempts: [{ n: 1, startedAt: NOW - 400 }],
    },
    {
      id: "review",
      title: "Review the diff",
      kind: "gate",
      status: "skipped",
      attemptCount: 0,
      attempts: [],
    },
  ],
  gates: [gate],
  after: [],
  history: [],
  createdAt: NOW - 1_000,
  updatedAt: NOW,
  seq: 1,
};

function stepsOf(source: RunDetail = detail): readonly StepView[] {
  return runView(source, { detail: source, now: NOW }).steps;
}

function nodes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("g[role='button']"));
}

/** A straight chain, so a >60-node graph is a realistic wide graph and not an artificial one. */
function chain(count: number): { graph: PlaybookGraph; steps: readonly StepView[] } {
  const stepSummaries: StepSummary[] = Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    title: `Step ${index}`,
    kind: "agent",
    status: "pending",
    attemptCount: 0,
  }));
  const summary: RunSummary = {
    id: RUN_ID,
    playbookId: "chain",
    playbookHash: "h",
    status: "running",
    inputs: {},
    cwd: "/repo",
    steps: stepSummaries,
    gates: [],
    after: [],
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    seq: 1,
  };
  return {
    graph: {
      nodes: stepSummaries.map((step) => ({ id: step.id, title: step.title, kind: step.kind })),
      edges: stepSummaries.slice(1).map((step, index) => ({
        from: `s${index}`,
        to: step.id,
        kind: "needs" as const,
      })),
      entry: ["s0"],
      terminals: [`s${count - 1}`],
    },
    steps: runView(summary, { now: NOW }).steps,
  };
}

describe("RunGraph", () => {
  it("renders one svg, one arrow marker per edge kind, and one button per node", () => {
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect: vi.fn() },
    });

    const svg = screen.getByRole("group", { name: "Playbook graph" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(container.querySelectorAll("marker").length).toBeGreaterThanOrEqual(4);
    expect(nodes(container)).toHaveLength(4);
  });

  it("joins each node with its step status and carries the D3 tooltip", () => {
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect: vi.fn() },
    });
    const byId = new Map(nodes(container).map((node) => [node.dataset["nodeId"], node]));

    expect(byId.get("plan")?.getAttribute("aria-label")).toBe(
      "plan · Plan the work · agent · Completed",
    );
    expect(byId.get("plan")?.querySelector("title")?.textContent).toBe(
      "plan · Plan the work · agent · Completed",
    );
    // A node with no step in this run still renders, with an unknown status.
    expect(byId.get("@end")?.getAttribute("aria-label")).toBe("@end · end · end · unknown");
  });

  it("reports a click on a node as a selection", async () => {
    const onSelect = vi.fn();
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect },
    });
    const impl = nodes(container).find((node) => node.dataset["nodeId"] === "impl");
    expect(impl).toBeDefined();
    if (impl === undefined) return;

    await fireEvent.click(impl);
    expect(onSelect).toHaveBeenCalledWith("impl");
  });

  it("selects a node with Enter and with Space", async () => {
    const onSelect = vi.fn();
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect },
    });
    const review = nodes(container).find((node) => node.dataset["nodeId"] === "review");
    if (review === undefined) return;

    await fireEvent.keyDown(review, { key: "Enter" });
    await fireEvent.keyDown(review, { key: " " });
    expect(onSelect).toHaveBeenNthCalledWith(1, "review");
    expect(onSelect).toHaveBeenNthCalledWith(2, "review");
  });

  it("marks the selected node and draws a skipped step at 40 %", () => {
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: "plan", onSelect: vi.fn() },
    });
    const byId = new Map(nodes(container).map((node) => [node.dataset["nodeId"], node]));

    expect(byId.get("plan")?.dataset["selected"]).toBe("true");
    expect(byId.get("review")?.dataset["skipped"]).toBe("true");
    expect(byId.get("impl")?.dataset["skipped"]).toBeUndefined();
  });

  it("draws a ring and an n pending badge on a node with a pending gate", () => {
    const { container } = render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect: vi.fn() },
    });
    const impl = nodes(container).find((node) => node.dataset["nodeId"] === "impl");
    expect(impl?.querySelector('[data-gate="ring"]')).not.toBeNull();
    expect(impl?.querySelector("[data-gate-count]")?.textContent?.trim()).toBe("1 pending");
    expect(container.querySelector("[data-node-id='plan'] [data-gate='ring']")).toBeNull();
  });

  it("falls back to the neutral tone for a tone it does not know", () => {
    const steps = stepsOf().map((step) =>
      step.id === "impl" ? { ...step, tone: "mystery" as StatusTone } : step,
    );
    const { container } = render(RunGraph, {
      props: { graph, steps, selectedId: null, onSelect: vi.fn() },
    });
    // The unknown tone is normalized to `neutral` (spec FR9: `data-tone` is always a `StatusTone`).
    const dot = container.querySelector("[data-node-id='impl'] circle");
    expect(dot?.getAttribute("data-tone")).toBe("neutral");
    expect(dot?.getAttribute("data-tone")).not.toBe("mystery");
  });

  it("renders 61 nodes fit to width with the size note", () => {
    const big = chain(61);
    const { container } = render(RunGraph, {
      props: { graph: big.graph, steps: big.steps, selectedId: null, onSelect: vi.fn() },
    });

    expect(nodes(container)).toHaveLength(61);
    expect(screen.getByText("too large to fit — scroll to explore")).toBeTruthy();
    const svg = screen.getByRole("group", { name: "Playbook graph" });
    // Fit to width is a bounded (legible) scale, never a truncation, and the note says to scroll.
    const width = Number(svg.getAttribute("width"));
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(4_000);
    expect(nodes(container)[60]?.getAttribute("aria-label")).toContain("s60");
  });

  it("omits the note for a graph that fits", () => {
    render(RunGraph, {
      props: { graph, steps: stepsOf(), selectedId: null, onSelect: vi.fn() },
    });
    expect(screen.queryByText("too large to fit — scroll to explore")).toBeNull();
  });
});

describe("ViewToggle", () => {
  it("offers Rail and Graph and reports the choice", async () => {
    const onView = vi.fn();
    render(ViewToggle, { props: { view: "rail", graphAvailable: true, onView } });

    const rail = screen.getByRole("button", { name: "Rail" });
    const graphButton = screen.getByRole("button", { name: "Graph" });
    expect(rail.getAttribute("aria-pressed")).toBe("true");
    expect(graphButton.getAttribute("aria-pressed")).toBe("false");

    await fireEvent.click(graphButton);
    expect(onView).toHaveBeenCalledWith("graph");
  });

  it("disables the graph half with a graph unavailable title when the detail has no graph", () => {
    render(ViewToggle, { props: { view: "rail", graphAvailable: false, onView: vi.fn() } });

    const graphButton = screen.getByRole("button", { name: "Graph" }) as HTMLButtonElement;
    expect(graphButton.disabled).toBe(true);
    expect(graphButton.getAttribute("title")).toBe("graph unavailable");
    expect((screen.getByRole("button", { name: "Rail" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("view state in the URL (FR17)", () => {
  it("round-trips ?view=graph&step=<id>", () => {
    const url = writeViewParams(new URL("http://argos.test/ui/runs/abc"), {
      view: "graph",
      step: "ship",
    });
    expect(url.search).toBe("?view=graph&step=ship");
    expect(readViewParams(url.search)).toEqual({ view: "graph", step: "ship" });
  });

  it("treats ?view=rail and an absent parameter as the same state", () => {
    expect(readViewParams("")).toEqual({ view: "rail", step: null });
    expect(readViewParams("?view=rail")).toEqual({ view: "rail", step: null });
    expect(writeViewParams(new URL("http://argos.test/ui/runs/abc?view=rail"), {
      view: "rail",
      step: null,
    }).search).toBe("");
  });

  it("keeps the step when the view changes and drops only what was cleared", () => {
    const url = writeViewParams(new URL("http://argos.test/ui/runs/abc?view=graph&step=plan"), {
      view: "rail",
      step: "plan",
    });
    expect(url.search).toBe("?step=plan");
    expect(readViewParams(url.search)).toEqual({ view: "rail", step: "plan" });
  });

  it("falls back to the rail for an unknown view instead of failing the page", () => {
    expect(readViewParams("?view=timeline&step=build")).toEqual({
      view: "rail",
      step: "build",
    });
  });
});
