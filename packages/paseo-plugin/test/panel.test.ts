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
  parseStartForm,
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

  it("offers Remove only on finished runs, removes once, and drops the run on refresh", async () => {
    const done = makeRun({ id: "run-1", status: "completed" });
    const live = makeRun({ id: "run-2", status: "running" });
    let runs = [done, live];
    const client = fakeRpc({
      removeRun: async (runId) => {
        runs = runs.filter((run) => run.id !== runId);
        return { runId, status: "completed" };
      },
    });
    client.listRuns.mockImplementation(async () => runs);
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const loaded = panelView(await panel.load());
    expect(loaded.runs.find((run) => run.id === "run-1")?.removable).toBe(true);
    expect(loaded.runs.find((run) => run.id === "run-2")?.removable).toBe(false);

    const model = await panel.removeRun("run-1");
    expect(client.removeRun).toHaveBeenCalledTimes(1);
    expect(client.removeRun).toHaveBeenCalledWith("run-1");
    expect(model.busyRuns).toEqual([]);
    expect(model.runs.map((run) => run.id)).toEqual(["run-2"]);
    panel.dispose();
  });

  it("keeps the run and reports run_terminal when the server refuses a remove", async () => {
    const run = makeRun({ id: "run-1", status: "completed" });
    const client = fakeRpc({
      runs: [run],
      removeRun: async () => {
        throw new PluginRpcError("run_terminal", "run run-1 is running; cancel it before removing it", 409);
      },
    });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    await panel.load();
    const model = await panel.removeRun("run-1");
    expect(model.error?.code).toBe("run_terminal");
    expect(model.busyRuns).toEqual([]);
    expect(model.runs.map((entry) => entry.id)).toEqual(["run-1"]);
    panel.dispose();
  });

  it("offers Retry only on failed steps of a finished run and retries once", async () => {
    const failed = makeRun({
      id: "run-1",
      status: "failed",
      steps: [
        makeStep({ id: "draft", status: "completed", attemptCount: 1 }),
        makeStep({ id: "build", status: "failed", attemptCount: 1, errorCode: "invalid_output" }),
        makeStep({ id: "ship", status: "skipped" }),
      ],
    });
    const running = makeRun({
      id: "run-2",
      status: "running",
      steps: [makeStep({ id: "build", status: "failed", attemptCount: 1 })],
    });
    const client = fakeRpc({ runs: [failed, running] });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const loaded = await panel.load();
    const views = panelView(loaded).runs;
    const retryable = (id: string) =>
      views.find((run) => run.id === id)?.steps.filter((step) => step.retryable).map((s) => s.id);
    expect(retryable("run-1")).toEqual(["build"]);
    expect(retryable("run-2")).toEqual([]);

    const pending = panel.retryStep("run-1", "build");
    expect(panel.getModel().busyRuns).toEqual(["run-1"]);
    // A double click while in flight is ignored.
    await panel.retryStep("run-1", "build");
    const model = await pending;

    expect(client.retryStep).toHaveBeenCalledTimes(1);
    expect(client.retryStep).toHaveBeenCalledWith("run-1", "build");
    expect(model.busyRuns).toEqual([]);
    expect(model.error).toBeNull();
  });

  it("keeps the stable code when a retry is refused", async () => {
    const client = fakeRpc({
      runs: [makeRun({ id: "run-1", status: "failed" })],
      retryStep: async () => {
        throw new PluginRpcError("run_terminal", "cancel it before retrying a step", 409);
      },
    });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const model = await panel.retryStep("run-1", "build");

    expect(model.error?.code).toBe("run_terminal");
    expect(model.busyRuns).toEqual([]);
  });

  it("starts a run from the form and refreshes the list", async () => {
    const client = fakeRpc({ runs: [] });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const pending = panel.startRun({ playbookId: "demo", inputs: { ticket: "42" } });
    expect(panel.getModel().starting).toBe(true);
    const outcome = await pending;

    expect(client.startRun).toHaveBeenCalledWith({ playbookId: "demo", inputs: { ticket: "42" } });
    expect(outcome.started?.runId).toBe("run-new");
    expect(outcome.model.starting).toBe(false);
    expect(client.listRuns).toHaveBeenCalled();
  });

  it("surfaces a start failure with its stable code", async () => {
    const client = fakeRpc({
      startRun: async () => {
        throw new PluginRpcError("playbook_invalid", "missing input ticket", 422);
      },
    });
    const panel = createPanel({ client, openEvents: fakeStream().openEvents });

    const outcome = await panel.startRun({ playbookId: "demo" });

    expect(outcome.started).toBeUndefined();
    expect(outcome.error?.code).toBe("playbook_invalid");
    expect(outcome.model.starting).toBe(false);
  });
});

describe("parseStartForm", () => {
  it("builds a minimal request and omits empty fields", () => {
    expect(parseStartForm({ playbookId: " demo ", cwd: "", inputs: "" })).toEqual({
      ok: true,
      request: { playbookId: "demo" },
    });
  });

  it("reads key=value lines as strings, keeping '=' inside values", () => {
    expect(
      parseStartForm({ playbookId: "demo", cwd: "/repo", inputs: "ticket=42\n\nquery = a=b \n" }),
    ).toEqual({
      ok: true,
      request: { playbookId: "demo", cwd: "/repo", inputs: { ticket: "42", query: "a=b" } },
    });
  });

  it("keeps typed values from a JSON object", () => {
    expect(
      parseStartForm({ playbookId: "demo", cwd: "", inputs: '{"n": 3, "dry": true, "s": "x"}' }),
    ).toEqual({ ok: true, request: { playbookId: "demo", inputs: { n: 3, dry: true, s: "x" } } });
  });

  it("rejects a missing playbook id, bad lines and non-scalar JSON", () => {
    expect(parseStartForm({ playbookId: " ", cwd: "", inputs: "" }).ok).toBe(false);
    expect(parseStartForm({ playbookId: "demo", cwd: "", inputs: "novalue" }).ok).toBe(false);
    expect(parseStartForm({ playbookId: "demo", cwd: "", inputs: "{oops" }).ok).toBe(false);
    expect(parseStartForm({ playbookId: "demo", cwd: "", inputs: '{"a": [1]}' }).ok).toBe(false);
  });
});
