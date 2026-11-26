// @vitest-environment jsdom
/**
 * The gate inbox page body (inbox FR3–FR6, FR9, FR10): every pending gate, oldest first, decided in
 * place through the page-level `RunActions`, plus the header's live count.
 *
 * The route file is not rendered — the repo has no `$app` alias for vitest — so these tests mount the
 * two components the page renders and wire them the way it does: one real `RunActions`, one real
 * `ToastStore`, and a stubbed `ArgosApi` (never a real fetch or EventSource).
 */

import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { GateSummary, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";

import { ArgosApiError, type ArgosApi } from "#lib/api";
import { runHref } from "#lib/paths";
import { RunActions } from "#lib/run-actions.svelte";
import { ToastStore } from "#lib/state/toasts.svelte";

import GateBadge from "./GateBadge.svelte";
import GateInbox from "./GateInbox.svelte";
import Toasts from "./Toasts.svelte";

const NOW = 1_700_000_100_000;
const RUN_A = "01J0000000000000000000000A";
const RUN_B = "01J0000000000000000000000B";
/** The rail's `localStorage` key; the inbox must ignore it (inbox FR9). */
const HIDDEN_KEY = "argos.hiddenWorkflows";

function gate(overrides: Partial<GateSummary> = {}): GateSummary {
  return {
    runId: RUN_A,
    gateId: "ship:1",
    stepId: "ship",
    kind: "step",
    question: "Ship it?",
    choices: { approve: { label: "Approve", comment: "optional" } },
    status: "pending",
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: RUN_A,
    playbookId: "release",
    playbookHash: "h",
    status: "waiting",
    inputs: {},
    cwd: "/repo",
    steps: [],
    gates: [],
    after: [],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    seq: 1,
    ...overrides,
  };
}

/** Three pending gates over two runs: 2h old, 1h old, 1m old. */
const RUNS: readonly RunSummary[] = [
  run({
    id: RUN_A,
    playbookId: "release",
    cwd: "/Users/dt/code/vsee",
    gates: [
      gate({
        runId: RUN_A,
        gateId: "ship:1",
        stepId: "ship",
        question: "Ship release 1.2.3?",
        createdAt: NOW - 7_200_000,
      }),
      gate({
        runId: RUN_A,
        gateId: "fix:1",
        stepId: "fix",
        question: "Fix the typo before shipping?",
        createdAt: NOW - 60_000,
      }),
    ],
  }),
  run({
    id: RUN_B,
    playbookId: "nightly",
    cwd: "/repo/argos",
    trigger: {
      kind: "schedule",
      scheduleId: "nightly",
      fireAt: NOW - 3_600_000,
      reason: "cron",
    },
    gates: [
      gate({
        runId: RUN_B,
        gateId: "review:1",
        stepId: "review",
        question: "Approve the nightly diff?",
        createdAt: NOW - 3_600_000,
      }),
    ],
  }),
];

function fakeApi(overrides: Partial<ArgosApi> = {}): ArgosApi {
  const base: ArgosApi = {
    listRuns: async () => [],
    getRun: async () => {
      throw new Error("unused");
    },
    startRun: async () => ({ runId: "new", taskId: "t" }),
    cancelRun: async (runId) => ({ runId, status: "cancelled" }),
    retryStep: async () => ({ runId: RUN_A, taskId: "t2" }),
    forkRun: async () => ({ runId: RUN_B, taskId: "t3" }),
    decideGate: async (runId, gateId, body) => ({
      runId,
      gateId,
      decision: body.decision,
      decidedAt: NOW,
    }),
    listPlaybooks: async (cwd) => ({ cwd, playbooks: [], errors: [] }),
    listSchedules: async () => [],
    info: async () => {
      throw new Error("unused");
    },
  };
  return { ...base, ...overrides };
}

/** The page's wiring: one `RunActions`, whose `deciding` is what the inbox renders. */
function harness(overrides: Partial<ArgosApi> = {}) {
  const api = fakeApi(overrides);
  const toasts = new ToastStore();
  const refresh = vi.fn(async () => undefined);
  const actions = new RunActions({
    api,
    toasts,
    refresh,
    navigate: vi.fn(),
    runPath: runHref,
    clientRequestId: () => "client-id",
  });
  return { api, toasts, refresh, actions };
}

type Harness = ReturnType<typeof harness>;

/** Mount the inbox the way the page does: `onDecide` is the page-level `RunActions.decide`. */
function mountInbox(
  test: Harness,
  options: { readonly runs?: readonly RunSummary[]; readonly deciding?: readonly string[] } = {},
) {
  return render(GateInbox, {
    props: {
      runs: options.runs ?? RUNS,
      now: NOW,
      timeZone: "UTC",
      deciding: options.deciding ?? test.actions.deciding,
      onDecide: (entry, decision, comment) =>
        test.actions.decide(entry.run.id, entry.gate, decision, comment),
    },
  });
}

function cards(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Pending gates" })).getAllByRole("listitem");
}

function questions(): (string | null | undefined)[] {
  return cards().map((card) => card.querySelector("p.question")?.textContent);
}

describe("GateInbox", () => {
  it("lists three pending gates over two runs, oldest first", () => {
    mountInbox(harness());
    expect(questions()).toEqual([
      "Ship release 1.2.3?",
      "Approve the nightly diff?",
      "Fix the typo before shipping?",
    ]);
    // The age comes from the gate's own open time, not the run's last activity.
    expect(cards()[0]?.textContent).toContain("waiting 2h");
    expect(cards()[2]?.textContent).toContain("waiting 1m");
  });

  it("shows the run context and one deep link to the run at that step", () => {
    mountInbox(harness());
    const [release, nightly] = cards();
    expect(release).toBeDefined();
    expect(nightly).toBeDefined();

    const first = within(release as HTMLElement);
    // playbook, project, short run id, trigger label, executor (inbox FR4).
    expect(first.getByText("release")).toBeTruthy();
    expect(first.getByText("vsee")).toBeTruthy();
    expect(first.getByText("#01J00000")).toBeTruthy();
    expect(first.getByText("Manual")).toBeTruthy();
    expect(first.getByText("paseo")).toBeTruthy();
    const firstLinks = first.getAllByRole("link");
    expect(firstLinks).toHaveLength(1);
    expect(firstLinks[0]?.getAttribute("href")).toBe(`/ui/runs/${RUN_A}?step=ship`);

    const second = within(nightly as HTMLElement);
    expect(second.getByText("nightly")).toBeTruthy();
    expect(second.getByText("argos")).toBeTruthy();
    expect(second.getByText("Schedule")).toBeTruthy();
    expect(second.getByRole("link").getAttribute("href")).toBe(`/ui/runs/${RUN_B}?step=review`);
  });

  it("decides in place once and disables the card while the decision is in flight", async () => {
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({
      decideGate: async (runId, gateId, body) => {
        await inFlight;
        return { runId, gateId, decision: body.decision, decidedAt: NOW };
      },
    });
    const decide = vi.spyOn(test.api, "decideGate");
    const view = mountInbox(test);

    const card = cards()[0] as HTMLElement;
    await fireEvent.input(within(card).getByRole("textbox"), {
      target: { value: "checked the changelog" },
    });
    await fireEvent.click(within(card).getByRole("button", { name: /Approve/ }));

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(RUN_A, "ship:1", {
      decision: "approve",
      comment: "checked the changelog",
      clientRequestId: "client-id",
    });

    // One decision in flight: `RunActions.deciding` names the gate, and the card follows it.
    expect(test.actions.deciding).toEqual([`${RUN_A}.ship:1`]);
    view.rerender({ deciding: test.actions.deciding });
    for (const button of within(card).getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
    expect(within(card).getByRole("textbox").hasAttribute("disabled")).toBe(true);

    release?.();
    await vi.waitFor(() => {
      expect(test.refresh).toHaveBeenCalledTimes(1);
    });
    expect(test.actions.deciding).toEqual([]);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("treats gate_already_decided as one refresh, one toast, and no second POST", async () => {
    const test = harness({
      decideGate: async () => {
        throw new ArgosApiError("gate_already_decided", "run was decided by someone else", 409);
      },
    });
    const decide = vi.spyOn(test.api, "decideGate");
    mountInbox(test);
    render(Toasts, { props: { store: test.toasts } });

    const card = cards()[0] as HTMLElement;
    await fireEvent.click(within(card).getByRole("button", { name: /Approve/ }));
    await vi.waitFor(() => {
      expect(test.refresh).toHaveBeenCalledTimes(1);
    });

    expect(test.toasts.items).toHaveLength(1);
    expect(test.toasts.items[0]).toMatchObject({ code: "gate_already_decided", tone: "info" });
    expect(screen.getByRole("status").textContent).toContain("already decided");
    // Refreshing is the response; a retry would be a second POST for a gate someone else won.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(test.refresh).toHaveBeenCalledTimes(1);
  });

  it("names `argos gates` in the empty state (inbox FR10)", () => {
    mountInbox(harness(), { runs: [] });
    expect(screen.queryByRole("list", { name: "Pending gates" })).toBeNull();
    expect(screen.getByText("No gates waiting")).toBeTruthy();
    expect(screen.getByText(/argos gates/)).toBeTruthy();
  });

  it("keeps a card whose workflow the rail hides (inbox FR9)", () => {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(["release"]));
    try {
      mountInbox(harness());
      expect(questions()).toContain("Ship release 1.2.3?");
      expect(cards()).toHaveLength(3);
    } finally {
      window.localStorage.removeItem(HIDDEN_KEY);
    }
  });
});

describe("GateBadge", () => {
  it("shows the pending count in a live region and links to the inbox (inbox FR6)", () => {
    render(GateBadge, { props: { count: 3 } });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/ui/gates");
    expect(link.textContent).toContain("Gates");
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe("3");
    expect(link.contains(live)).toBe(true);
  });
});
