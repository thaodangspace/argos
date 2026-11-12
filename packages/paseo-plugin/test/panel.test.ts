/**
 * Panel model test (FR28, plan Phase 9 verification): runs render with statuses, pending gates show
 * choices, a decision calls the contract exactly once, a duplicate decision refreshes without a
 * second call, and an SSE reconnect re-fetches the full list.
 */

import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_PANEL,
  createPanel,
  decideGateOnce,
  gateKey,
  loadPanel,
  panelView,
  pendingGates,
  runView,
  sortRuns,
  subscribeRuns,
  type PanelModel,
} from "../shared/panel";
import {
  ARGOS_SERVER_UNREACHABLE,
  PluginRpcError,
  type SseHandlers,
} from "../shared/rpc-client";
import { fakeRpc, fakeStream, makeGate, makeRun, makeStep } from "./support.js";

function pendingRun(): ReturnType<typeof makeRun> {
  return makeRun({
    id: "run-1",
    status: "waiting",
    updatedAt: 2_000,
    steps: [
      makeStep({ id: "draft", status: "completed", attemptCount: 1 }),
      makeStep({ id: "review", kind: "gate", status: "waiting" }),
      makeStep({ id: "ship", status: "pending" }),
    ],
    gates: [makeGate({ gateId: "review:1", runId: "run-1" })],
  });
}

describe("loadPanel", () => {
  it("sorts runs by updatedAt desc and keeps only pending gates", async () => {
    const decided = makeGate({
      gateId: "draft:1",
      stepId: "draft",
      status: "decided",
      decision: "approve",
      decidedAt: 1_500,
    });
    const older = makeRun({ id: "run-old", updatedAt: 1_000, status: "completed" });
    const newer = makeRun({
      id: "run-new",
      updatedAt: 3_000,
      status: "waiting",
      gates: [makeGate({ gateId: "review:1", runId: "run-new" }), decided],
    });
    const client = fakeRpc({ runs: [older, newer] });

    const loaded = await loadPanel({ client });

    expect(loaded.runs.map((run) => run.id)).toEqual(["run-new", "run-old"]);
    expect(loaded.gates.map((gate) => gate.gateId)).toEqual(["review:1"]);
    expect(client.listRuns).toHaveBeenCalledTimes(1);
  });

  it("sorts deterministically when two runs share updatedAt", () => {
    const runs = [
      makeRun({ id: "run-a", updatedAt: 5 }),
      makeRun({ id: "run-b", updatedAt: 5 }),
    ];
    expect(sortRuns(runs).map((run) => run.id)).toEqual(["run-b", "run-a"]);
    expect(pendingGates(runs)).toEqual([]);
  });

  it("surfaces an unreachable server as the plugin's typed error", async () => {
    const client = fakeRpc({
      runs: [],
    });
    client.listRuns.mockRejectedValueOnce(
      new PluginRpcError(ARGOS_SERVER_UNREACHABLE, "Argos server not running", 0),
    );
    await expect(loadPanel({ client })).rejects.toMatchObject({
      code: ARGOS_SERVER_UNREACHABLE,
    });
  });
});

describe("projections", () => {
  it("renders run status, step statuses, and the pending gate's choices", () => {
    const run = pendingRun();
    const view = runView(run);

    expect(view.status).toBe("waiting");
    expect(view.statusLabel).toBe("Waiting for gate");
    expect(view.tone).toBe("warning");
    expect(view.steps.map((step) => [step.id, step.statusLabel, step.tone])).toEqual([
      ["draft", "Completed", "success"],
      ["review", "Waiting for gate", "warning"],
      ["ship", "Pending", "neutral"],
    ]);
    expect(view.gates).toHaveLength(1);
    const gate = view.gates[0];
    expect(gate?.gateId).toBe("review:1");
    expect(gate?.question).toBe("Ship it?");
    expect(gate?.choices.map((choice) => choice.id)).toEqual(["approve", "reject"]);
    expect(gate?.choices.map((choice) => choice.tone)).toEqual(["accent", "danger"]);
    expect(gate?.deciding).toBe(false);
    expect(view.detail).toBe("1/3 steps · gate review:1 waiting");
  });

  it("marks a gate deciding while its decision is in flight", () => {
    const model: PanelModel = {
      ...EMPTY_PANEL,
      runs: [pendingRun()],
      gates: [makeGate({ gateId: "review:1", runId: "run-1" })],
      inFlight: [gateKey("run-1", "review:1")],
    };
    const view = panelView(model);
    expect(view.gates[0]?.deciding).toBe(true);
    expect(view.pendingGates).toBe(1);
    expect(view.running).toBe(0);
    expect(view.heading).toBe("1 run · 0 running · 1 gate");
  });

  it("shows 'Argos server not running' when the model carries the unreachable error", () => {
    const view = panelView({
      ...EMPTY_PANEL,
      error: { code: ARGOS_SERVER_UNREACHABLE, message: "Argos server not running" },
    });
    expect(view.statusLabel).toBe("Argos server not running");
    expect(view.statusTone).toBe("danger");
    expect(view.empty).toBe(true);
    expect(view.runs).toEqual([]);
  });

  it("reports the failed step's error code in the run detail", () => {
    const run = makeRun({
      id: "run-failed",
      status: "failed",
      steps: [makeStep({ id: "draft", status: "failed", errorCode: "step_timeout" })],
    });
    expect(runView(run).detail).toBe("0/1 steps · step_timeout");
  });
});

describe("decideGateOnce", () => {
  it("calls the contract exactly once and publishes the in-flight model first", async () => {
    const run = pendingRun();
    const client = fakeRpc({ runs: [run] });
    const published: PanelModel[] = [];
    const model: PanelModel = {
      ...EMPTY_PANEL,
      runs: [run],
      gates: [makeGate({ gateId: "review:1", runId: "run-1" })],
    };

    // The server answers the refresh with the gate decided and the run completed.
    const decidedRun = makeRun({
      id: "run-1",
      status: "completed",
      updatedAt: 3_000,
      steps: run.steps.map((step) => ({ ...step, status: "completed" as const })),
      gates: [
        makeGate({
          gateId: "review:1",
          runId: "run-1",
          status: "decided",
          decision: "approve",
          decidedAt: 2_500,
        }),
      ],
    });

    client.listRuns.mockImplementation(async () => {
      return client.decideGate.mock.calls.length > 0 ? [decidedRun] : [run];
    });

    const result = await decideGateOnce(
      model,
      { runId: "run-1", gateId: "review:1", decision: "approve", comment: "ship it" },
      { client, now: () => 2_600, onModel: (next) => published.push(next) },
    );

    expect(client.decideGate).toHaveBeenCalledTimes(1);
    expect(client.decideGate).toHaveBeenCalledWith("run-1", "review:1", {
      decision: "approve",
      comment: "ship it",
    });
    expect(published[0]?.inFlight).toEqual([gateKey("run-1", "review:1")]);
    expect(published[0]?.error).toBeNull();
    expect(result.outcome).toBe("decided");
    expect(result.receipt?.decision).toBe("approve");
    expect(result.model.inFlight).toEqual([]);
    expect(result.model.runs[0]?.status).toBe("completed");
    expect(result.model.gates).toEqual([]);
    expect(result.model.loadedAt).toBe(2_600);
  });

  it("refreshes instead of retrying when the gate was already decided", async () => {
    const run = pendingRun();
    const client = fakeRpc({ runs: [run] });
    client.decideGate.mockRejectedValueOnce(
      new PluginRpcError(
        "gate_already_decided",
        "gate review:1 was already decided (reject) at 2000",
        409,
      ),
    );
    const model: PanelModel = { ...EMPTY_PANEL, runs: [run] };

    const result = await decideGateOnce(
      model,
      { runId: "run-1", gateId: "review:1", decision: "approve" },
      { client },
    );

    expect(client.decideGate).toHaveBeenCalledTimes(1);
    expect(client.listRuns).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("already_decided");
    expect(result.error?.code).toBe("gate_already_decided");
    expect(result.model.error?.code).toBe("gate_already_decided");
    expect(result.model.inFlight).toEqual([]);
  });

  it("ignores a second click while the first decision is in flight", async () => {
    const run = pendingRun();
    const client = fakeRpc({ runs: [run] });
    const inFlight: PanelModel = {
      ...EMPTY_PANEL,
      runs: [run],
      inFlight: [gateKey("run-1", "review:1")],
    };

    const result = await decideGateOnce(
      inFlight,
      { runId: "run-1", gateId: "review:1", decision: "approve" },
      { client },
    );

    expect(result.outcome).toBe("duplicate");
    expect(client.decideGate).not.toHaveBeenCalled();
    expect(result.model).toBe(inFlight);
  });

  it("keeps the error and re-enables the buttons on any other failure", async () => {
    const run = pendingRun();
    const client = fakeRpc({ runs: [run] });
    client.decideGate.mockRejectedValueOnce(
      new PluginRpcError("gate_unknown", "unknown gate", 404),
    );

    const result = await decideGateOnce(
      { ...EMPTY_PANEL, runs: [run] },
      { runId: "run-1", gateId: "review:1", decision: "approve" },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.model.error).toEqual({ code: "gate_unknown", message: "unknown gate" });
    expect(result.model.inFlight).toEqual([]);
    expect(client.listRuns).not.toHaveBeenCalled();
  });
});

describe("subscribeRuns", () => {
  interface Scheduled {
    callback: () => void;
    delayMs: number;
  }

  function scheduler(scheduled: Scheduled[]): (callback: () => void, delayMs: number) => () => void {
    return (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return () => undefined;
    };
  }

  it("delivers a snapshot and single changed runs", () => {
    const stream = fakeStream();
    const onSnapshot = vi.fn();
    const onRun = vi.fn();
    const subscription = subscribeRuns({
      openEvents: stream.openEvents,
      onSnapshot,
      onRun,
      reconnect: { schedule: scheduler([]) },
    });

    const run = makeRun({ id: "run-1" });
    stream.push("snapshot", { runs: [run] });
    stream.push("run", run);

    expect(onSnapshot).toHaveBeenCalledWith([run]);
    expect(onRun).toHaveBeenCalledWith(run);
    subscription.close();
  });

  it("reconnects with capped exponential backoff and asks for a full re-fetch", () => {
    const scheduled: Scheduled[] = [];
    const onReconnect = vi.fn();
    const onStatus = vi.fn();
    const stream = fakeStream();
    const subscription = subscribeRuns({
      openEvents: stream.openEvents,
      onSnapshot: () => undefined,
      onReconnect,
      onStatus,
      reconnect: { delayMs: 100, maxDelayMs: 250, schedule: scheduler(scheduled) },
    });

    expect(stream.opened).toBe(1);
    stream.drop();
    expect(onStatus).toHaveBeenCalledWith("closed", expect.objectContaining({ code: ARGOS_SERVER_UNREACHABLE }));
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([100]);

    // A failed re-open doubles the delay, capped at maxDelayMs.
    const failing: SseHandlers[] = [];
    const failingOpenEvents = (handlers: SseHandlers) => {
      failing.push(handlers);
      throw new PluginRpcError(ARGOS_SERVER_UNREACHABLE, "Argos server not running", 0);
    };
    const retrying = subscribeRuns({
      openEvents: failingOpenEvents,
      onSnapshot: () => undefined,
      reconnect: { delayMs: 100, maxDelayMs: 250, schedule: scheduler(scheduled) },
    });
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([100, 100]);
    scheduled[1]?.callback();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([100, 100, 200]);
    scheduled[2]?.callback();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([100, 100, 200, 250]);
    expect(failing).toHaveLength(3);

    // A successful re-open resets the backoff and triggers the full re-fetch.
    scheduled[0]?.callback();
    expect(stream.opened).toBe(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    retrying.close();
    subscription.close();
    expect(stream.closed).toBeGreaterThanOrEqual(1);

    // A closed subscription schedules nothing more.
    const before = scheduled.length;
    stream.drop();
    expect(scheduled).toHaveLength(before);
  });
});

describe("createPanel", () => {
  it("keeps one model, applies snapshots, and re-fetches the list after a reconnect", async () => {
    const run = makeRun({ id: "run-1", status: "running", updatedAt: 1_500 });
    const client = fakeRpc({ runs: [run] });
    const stream = fakeStream();
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const panel = createPanel({
      client,
      openEvents: stream.openEvents,
      reconnect: {
        delayMs: 10,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => undefined;
        },
      },
    });
    const seen: PanelModel[] = [];
    const unsubscribe = panel.subscribe((model) => seen.push(model));

    panel.start();
    stream.push("snapshot", { runs: [run] });
    expect(panel.getModel().runs.map((entry) => entry.id)).toEqual(["run-1"]);
    expect(panel.getModel().connected).toBe(true);

    // The server advanced while the stream was down; the reconnect must re-fetch everything.
    const finished = makeRun({ id: "run-1", status: "completed", updatedAt: 9_000 });
    client.listRuns.mockImplementation(async () => [finished]);
    stream.drop();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.callback();
    await vi.waitFor(() => {
      expect(panel.getModel().runs[0]?.status).toBe("completed");
    });
    expect(client.listRuns).toHaveBeenCalledTimes(1);

    panel.dispose();
    expect(client.close).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(seen.length).toBeGreaterThan(0);
  });

  it("records a load failure in the model instead of throwing", async () => {
    const client = fakeRpc({ runs: [] });
    client.listRuns.mockRejectedValueOnce(
      new PluginRpcError(ARGOS_SERVER_UNREACHABLE, "Argos server not running", 0),
    );
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const model = await panel.load();

    expect(model.error?.code).toBe(ARGOS_SERVER_UNREACHABLE);
    expect(panelView(model).statusLabel).toBe("Argos server not running");
    expect(model.loading).toBe(false);
    panel.dispose();
  });

  it("cancels a run once and refreshes", async () => {
    const run = makeRun({ id: "run-1", status: "running" });
    const client = fakeRpc({ runs: [run] });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    await panel.load();
    const model = await panel.cancelRun("run-1");

    expect(client.cancelRun).toHaveBeenCalledTimes(1);
    expect(model.busyRuns).toEqual([]);
  });
});
