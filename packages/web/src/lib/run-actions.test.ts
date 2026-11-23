/**
 * Run-page mutations (spec FR8/FR9/FR12): cancel, retry, fork, and gate decisions.
 *
 * These are the page handlers moved out of `+page.svelte`, so each one is asserted here — one API
 * call, the right arguments, a refresh or a navigation, and the stable code on failure.
 */

import { describe, expect, it, vi } from "vitest";

import { gateView, type GateView } from "@thaodangspace/argos-core/view";

import { ArgosApiError, type ArgosApi } from "./api.js";
import { RunActions } from "./run-actions.svelte.js";
import { ToastStore } from "./state/toasts.svelte.js";

const RUN = "01J0000000000000000000000A";

function api(overrides: Partial<ArgosApi> = {}): ArgosApi {
  const base: ArgosApi = {
    listRuns: async () => [],
    getRun: async () => {
      throw new Error("unused");
    },
    startRun: async () => ({ runId: "new", taskId: "t" }),
    cancelRun: async (runId) => ({ runId, status: "cancelled" }),
    retryStep: async () => ({ runId: RUN, taskId: "t2" }),
    forkRun: async () => ({ runId: "01J0000000000000000000000B", taskId: "t3" }),
    decideGate: async (runId, gateId, body) => ({
      runId,
      gateId,
      decision: body.decision,
      decidedAt: 1,
    }),
    listPlaybooks: async (cwd) => ({ cwd, playbooks: [], errors: [] }),
    listSchedules: async () => [],
    info: async () => {
      throw new Error("unused");
    },
  };
  return { ...base, ...overrides };
}

function gate(): GateView {
  return gateView({
    runId: RUN,
    gateId: "ship:1",
    stepId: "ship",
    kind: "step",
    question: "Ship it?",
    choices: { approve: { label: "Approve", comment: "none", color: "success" } },
    status: "pending",
  });
}

function harness(overrides: Partial<ArgosApi> = {}) {
  const toasts = new ToastStore();
  const refresh = vi.fn(async () => undefined);
  const navigate = vi.fn((path: string) => {
    void path;
  });
  const fake = api(overrides);
  const actions = new RunActions({
    api: fake,
    toasts,
    refresh,
    navigate,
    runPath: (runId) => `/ui/runs/${runId}`,
    clientRequestId: () => "client-id",
  });
  return { actions, toasts, refresh, navigate, api: fake };
}

const step = { id: "ship", title: "Ship" };

describe("cancel", () => {
  it("arms on the first click and cancels once on the second", async () => {
    const { actions, toasts, refresh, api: fake } = harness();
    const cancel = vi.spyOn(fake, "cancelRun");

    await actions.cancel(RUN);
    expect(cancel).not.toHaveBeenCalled();
    expect(actions.confirmingCancel).toBe(true);

    await actions.cancel(RUN);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(RUN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(actions.confirmingCancel).toBe(false);
    expect(actions.busy).toBe(false);
    expect(toasts.items.some((toast) => toast.message === "Run cancelled.")).toBe(true);
  });

  it("reports the server code and still refreshes", async () => {
    const { actions, toasts, refresh } = harness({
      cancelRun: async () => {
        throw new ArgosApiError("run_terminal", "already finished", 409);
      },
    });
    await actions.cancel(RUN);
    await actions.cancel(RUN);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts.items.some((toast) => toast.code === "run_terminal" && toast.tone === "error")).toBe(
      true,
    );
  });
});

describe("retry", () => {
  it("posts the selected step and refreshes", async () => {
    const { actions, toasts, refresh, api: fake, navigate } = harness();
    const retry = vi.spyOn(fake, "retryStep");

    await actions.retry(RUN, step);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(RUN, "ship");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts.items.some((toast) => toast.message.startsWith("Retrying Ship"))).toBe(true);
  });

  it("does nothing without a selected step", async () => {
    const { actions, api: fake, refresh } = harness();
    const retry = vi.spyOn(fake, "retryStep");
    await actions.retry(RUN, null);
    expect(retry).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("fork", () => {
  it("navigates to the new run instead of refreshing", async () => {
    const { actions, navigate, refresh, api: fake } = harness();
    const fork = vi.spyOn(fake, "forkRun");

    await actions.fork(RUN, step);
    expect(fork).toHaveBeenCalledWith(RUN, "ship");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/ui/runs/01J0000000000000000000000B");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing without a selected step, and reports a refusal", async () => {
    const empty = harness();
    await empty.actions.fork(RUN, null);
    expect(empty.navigate).not.toHaveBeenCalled();

    const failing = harness({
      forkRun: async () => {
        throw new ArgosApiError("definition_conflict", "edit escapes the fork point", 409);
      },
    });
    await failing.actions.fork(RUN, step);
    expect(failing.navigate).not.toHaveBeenCalled();
    expect(failing.toasts.items.some((toast) => toast.code === "definition_conflict")).toBe(true);
  });
});

describe("decide", () => {
  it("sends one idempotent decision and refreshes", async () => {
    const { actions, toasts, refresh, api: fake } = harness();
    const decide = vi.spyOn(fake, "decideGate");
    const target = gate();

    await actions.decide(RUN, target, "approve", "ship it");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(RUN, "ship:1", {
      decision: "approve",
      comment: "ship it",
      clientRequestId: "client-id",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(actions.deciding).toEqual([]);
    expect(toasts.items.some((toast) => toast.tone === "success")).toBe(true);
  });

  it("ignores a second click while that gate is in flight", async () => {
    const { actions, api: fake } = harness();
    const decide = vi.spyOn(fake, "decideGate");
    const target = gate();
    actions.deciding = [target.key];
    await actions.decide(RUN, target, "approve");
    expect(decide).not.toHaveBeenCalled();
  });

  it("treats gate_already_decided as refresh, not retry", async () => {
    const { actions, toasts, refresh } = harness({
      decideGate: async () => {
        throw new ArgosApiError("gate_already_decided", "someone else won", 409);
      },
    });
    await actions.decide(RUN, gate(), "approve");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts.items.some((toast) => toast.code === "gate_already_decided" && toast.tone === "info")).toBe(
      true,
    );
    expect(actions.deciding).toEqual([]);
  });
});
