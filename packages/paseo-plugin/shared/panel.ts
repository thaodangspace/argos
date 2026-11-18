/**
 * Panel store (FR28) — the Paseo-specific half: SSE subscription, the store, and gate decisions.
 *
 * The pure projection (labels, tones, grouping, the step log, the start form) lives in
 * `@thaodangspace/argos-core/view` and is re-exported here, so the Paseo client and the web UI share
 * one implementation (spec FR6). Three rules keep the store honest:
 *
 * 1. {@link loadPanel} and {@link subscribeRuns} are the only readers; the server's SSE stream is
 *    the source of truth (an `event: snapshot` frame is a full list, an `event: run` frame is one
 *    changed run).
 * 2. {@link decideGateOnce} performs **exactly one** `decideGate` call per user action, records the
 *    gate in `inFlight` so the buttons disable, and treats `gate_already_decided` as "refresh",
 *    never "retry".
 * 3. `runView`/`panelView` (re-exported from core) turn the model into labels and tones; the client
 *    entry maps tones to theme tokens.
 */

import {
  SSE_RUN_EVENT,
  SSE_SNAPSHOT_EVENT,
  type GateDecisionResponse,
  type GateSummary,
  type RunDetail,
  type RunSummary,
  type StartRunRequest,
  type StartRunResponse,
} from "@thaodangspace/argos-core/rpc/contracts";
import {
  gateKey,
  pendingGates,
  sortRuns,
  type PanelError,
  type PanelViewInput,
  type RunFilter,
} from "@thaodangspace/argos-core/view";

import {
  PluginRpcError,
  type EventStreamHandle,
  type OpenEvents,
  type PanelRpc,
  type SseFrame,
} from "./rpc-client";

// The pure projection is one implementation for both clients (spec FR6).
export * from "@thaodangspace/argos-core/view";

// ------------------------------------------------------------------ model

export interface PanelModel extends PanelViewInput {
  /** A start-run request is in flight: the start form disables. */
  readonly starting: boolean;
  readonly loadedAt: number;
}

export const EMPTY_PANEL: PanelModel = {
  runs: [],
  gates: [],
  inFlight: [],
  busyRuns: [],
  starting: false,
  selectedRunId: null,
  detail: null,
  detailLoading: false,
  filter: "all",
  loading: false,
  connected: false,
  error: null,
  loadedAt: 0,
};

function without(values: readonly string[], value: string): string[] {
  return values.filter((entry) => entry !== value);
}

export function toPanelError(error: unknown): PanelError {
  const pluginError = PluginRpcError.from(error);
  return { code: pluginError.code, message: pluginError.message };
}

export interface LoadPanelInput {
  readonly client: PanelRpc;
}

export interface PanelSnapshot {
  readonly runs: RunSummary[];
  readonly gates: GateSummary[];
}

/**
 * Read the whole panel: `GET /runs` for the runs, then keep the pending gates. The server returns
 * newest-created first; the panel sorts by `updatedAt` desc so the run that just moved is on top.
 */
export async function loadPanel(input: LoadPanelInput): Promise<PanelSnapshot> {
  const runs = sortRuns(await input.client.listRuns());
  return { runs, gates: pendingGates(runs) };
}

// ------------------------------------------------------------------ decide

export interface DecideGateAction {
  readonly runId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
}

export interface DecideGateOnceDeps {
  readonly client: PanelRpc;
  readonly now?: () => number;
  /** Publishes the intermediate (in-flight) and final models: how the UI disables buttons. */
  readonly onModel?: (model: PanelModel) => void;
}

export type DecideGateOutcome =
  | "decided"
  | "already_decided"
  | "failed"
  /** The same gate was already in flight: nothing was called. */
  | "duplicate";

export interface DecideGateOnceResult {
  readonly model: PanelModel;
  readonly outcome: DecideGateOutcome;
  readonly receipt?: GateDecisionResponse;
  readonly error?: PanelError;
}

/**
 * Decide one gate with **exactly one** RPC call.
 *
 * - an action for a gate already in `model.inFlight` returns `duplicate` without a call (a
 *   double-click cannot decide twice);
 * - success refreshes the whole list through `GET /runs` (the decision document is fresher than
 *   the mirrored run record, and the next steps may already have moved);
 * - `gate_already_decided` is not an error the user can fix by retrying: refresh and report
 *   `already_decided`;
 * - every other failure lands in `model.error` with its stable code.
 */
export async function decideGateOnce(
  model: PanelModel,
  action: DecideGateAction,
  deps: DecideGateOnceDeps,
): Promise<DecideGateOnceResult> {
  const now = deps.now ?? Date.now;
  const key = gateKey(action.runId, action.gateId);
  if (model.inFlight.includes(key)) return { model, outcome: "duplicate" };

  const publish = (next: PanelModel): PanelModel => {
    deps.onModel?.(next);
    return next;
  };

  const pending = publish({
    ...model,
    inFlight: [...model.inFlight, key],
    error: null,
  });

  const refresh = async (): Promise<PanelSnapshot> => loadPanel({ client: deps.client });

  try {
    const receipt = await deps.client.decideGate(action.runId, action.gateId, {
      decision: action.decision,
      ...(action.comment === undefined ? {} : { comment: action.comment }),
    });
    const loaded = await refresh();
    const settled = publish({
      ...pending,
      inFlight: without(pending.inFlight, key),
      runs: loaded.runs,
      gates: loaded.gates,
      connected: true,
      loading: false,
      loadedAt: now(),
    });
    return { model: settled, outcome: "decided", receipt };
  } catch (error) {
    const failure = toPanelError(error);
    if (failure.code === "gate_already_decided") {
      try {
        const loaded = await refresh();
        const refreshed = publish({
          ...pending,
          inFlight: without(pending.inFlight, key),
          runs: loaded.runs,
          gates: loaded.gates,
          connected: true,
          loading: false,
          error: failure,
          loadedAt: now(),
        });
        return { model: refreshed, outcome: "already_decided", error: failure };
      } catch (refreshError) {
        const refreshFailure = toPanelError(refreshError);
        const failed = publish({
          ...pending,
          inFlight: without(pending.inFlight, key),
          error: refreshFailure,
        });
        return { model: failed, outcome: "already_decided", error: failure };
      }
    }
    const failed = publish({
      ...pending,
      inFlight: without(pending.inFlight, key),
      error: failure,
    });
    return { model: failed, outcome: "failed", error: failure };
  }
}

// ------------------------------------------------------------------ SSE

/** Backoff knobs; the defaults are 1 s doubling to 8 s, never unbounded. */
export interface ReconnectPolicy {
  readonly delayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable timer (tests drive the reconnect synchronously). */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

export type SubscriptionStatus = "open" | "closed" | "error";

export interface SubscribeRunsOptions {
  /** Stream opener; production is `client.openEvents`, tests pass a queue. */
  readonly openEvents: OpenEvents;
  /** A full list arrived (`event: snapshot`). */
  readonly onSnapshot: (runs: RunSummary[]) => void;
  /** One changed run arrived (`event: run`). */
  readonly onRun?: (run: RunSummary) => void;
  readonly onStatus?: (status: SubscriptionStatus, error?: PanelError) => void;
  /** Called after a dropped stream is re-opened: the caller re-fetches the full list. */
  readonly onReconnect?: () => void;
  readonly reconnect?: ReconnectPolicy;
}

export interface RunSubscription {
  /** Stop consuming and cancel any pending reconnect. */
  close(): void;
  /** How many consecutive failed connects happened (0 while healthy). */
  readonly attempts: number;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

function parseRunList(data: string): RunSummary[] {
  const parsed = JSON.parse(data) as { runs?: unknown };
  return Array.isArray(parsed.runs) ? (parsed.runs as RunSummary[]) : [];
}

function parseRun(data: string): RunSummary {
  return JSON.parse(data) as RunSummary;
}

/**
 * Consume `GET /events` and reconnect with capped exponential backoff. There is no client-side
 * state machine: a snapshot replaces the list, a run frame replaces one entry, and a reconnect
 * asks the caller to re-fetch everything (the server may have advanced while we were away).
 */
export function subscribeRuns(options: SubscribeRunsOptions): RunSubscription {
  const policy = options.reconnect ?? {};
  const baseDelay = policy.delayMs ?? 1_000;
  const maxDelay = policy.maxDelayMs ?? 8_000;
  const schedule = policy.schedule ?? defaultSchedule;
  let handle: EventStreamHandle | undefined;
  let reconnectTimer: (() => void) | undefined;
  let attempts = 0;
  let closed = false;

  const drop = (error?: PanelError): void => {
    handle?.close();
    handle = undefined;
    if (closed) return;
    options.onStatus?.("closed", error);
    const exponent = Math.min(attempts, 10);
    const delay = Math.min(maxDelay, baseDelay * 2 ** exponent);
    attempts += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (closed) return;
    try {
      handle = options.openEvents({
        onOpen: () => {
          const reconnected = attempts > 0;
          attempts = 0;
          options.onStatus?.("open");
          if (reconnected) options.onReconnect?.();
        },
        onFrame: (frame: SseFrame) => {
          try {
            if (frame.event === SSE_SNAPSHOT_EVENT) options.onSnapshot(parseRunList(frame.data));
            else if (frame.event === SSE_RUN_EVENT) options.onRun?.(parseRun(frame.data));
          } catch (error) {
            options.onStatus?.("error", toPanelError(error));
          }
        },
        onError: (error) => {
          drop(toPanelError(error));
        },
      });
    } catch (error) {
      drop(toPanelError(error));
    }
  };

  connect();

  return {
    get attempts(): number {
      return attempts;
    },
    close: () => {
      if (closed) return;
      closed = true;
      handle?.close();
      handle = undefined;
      reconnectTimer?.();
      reconnectTimer = undefined;
    },
  };
}

// ------------------------------------------------------------------ store

export interface StartRunOutcome {
  readonly model: PanelModel;
  readonly started?: StartRunResponse;
  readonly error?: PanelError;
}

export interface PanelStoreOptions {
  readonly client: PanelRpc;
  /** Default `client.openEvents`. */
  readonly openEvents?: OpenEvents;
  readonly now?: () => number;
  readonly reconnect?: ReconnectPolicy;
}

export interface PanelStore {
  getModel(): PanelModel;
  subscribe(listener: (model: PanelModel) => void): () => void;
  /** Full refresh (`GET /runs`). Never throws: the failure lands in `model.error`. */
  load(): Promise<PanelModel>;
  /** Subscribe to `GET /events` and reconnect on drop. Idempotent. */
  start(): void;
  stop(): void;
  /** Open a run's CI page: `GET /runs/:id` (attempts, outputs, history). */
  selectRun(runId: string): Promise<PanelModel>;
  /** Back to the run list. */
  closeRun(): PanelModel;
  /** Narrow the run list (`all` clears the filter). */
  setFilter(filter: RunFilter): PanelModel;
  /** Decide one gate exactly once; resolves with the settled model. */
  decideGate(action: DecideGateAction): Promise<DecideGateOnceResult>;
  /** Cancel one run; the buttons disable while it is in flight. */
  cancelRun(runId: string): Promise<PanelModel>;
  /** Retry one step of a finished run (that step and its downstream re-run). */
  retryStep(runId: string, stepId: string): Promise<PanelModel>;
  /** Delete a finished run; the refresh drops it from the list. Failures land in `model.error`. */
  removeRun(runId: string): Promise<PanelModel>;
  /** Start a run from the panel form; never throws, failures land in `model.error`. */
  startRun(request: StartRunRequest): Promise<StartRunOutcome>;
  /** Stop consuming and release the HTTP client (plugin teardown). */
  dispose(): void;
}

function mergeRun(runs: readonly RunSummary[], run: RunSummary): RunSummary[] {
  const next = runs.some((entry) => entry.id === run.id)
    ? runs.map((entry) => (entry.id === run.id ? run : entry))
    : [...runs, run];
  return sortRuns(next);
}

/** The panel store: one model, one SSE subscription, one client. */
export function createPanel(options: PanelStoreOptions): PanelStore {
  const now = options.now ?? Date.now;
  const listeners = new Set<(model: PanelModel) => void>();
  const openEvents: OpenEvents = options.openEvents ?? options.client.openEvents;
  let model: PanelModel = EMPTY_PANEL;
  let subscription: RunSubscription | undefined;
  let disposed = false;

  const set = (next: PanelModel): PanelModel => {
    model = next;
    for (const listener of listeners) listener(model);
    return model;
  };

  /**
   * Re-fetch the open run's detail when its summary moved. The bridge polls the list every 2 s, so
   * `seq` is what decides: an unchanged run causes no extra request.
   */
  const syncDetail = (): void => {
    const selected = model.selectedRunId;
    if (selected === null || model.detailLoading) return;
    const run = model.runs.find((entry) => entry.id === selected);
    if (run === undefined) {
      if (model.detail === null && model.selectedRunId === null) return;
      set({ ...model, selectedRunId: null, detail: null, detailLoading: false });
      return;
    }
    if (model.detail !== null && model.detail.seq === run.seq) return;
    void store.selectRun(selected);
  };

  /** Mark one run busy, call `action` once, then refresh; a failure lands in `model.error`. */
  const runBusy = async (runId: string, action: () => Promise<void>): Promise<PanelModel> => {
    if (model.busyRuns.includes(runId)) return model;
    const pending = set({ ...model, busyRuns: [...model.busyRuns, runId], error: null });
    try {
      await action();
    } catch (error) {
      return set({
        ...pending,
        busyRuns: without(model.busyRuns, runId),
        error: toPanelError(error),
      });
    }
    if (disposed) return model;
    await store.load();
    return set({ ...model, busyRuns: without(model.busyRuns, runId) });
  };

  const store: PanelStore = {
    getModel: () => model,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    load: async () => {
      if (disposed) return model;
      set({ ...model, loading: true });
      try {
        const loaded = await loadPanel({ client: options.client });
        const next = set({
          ...model,
          runs: loaded.runs,
          gates: loaded.gates,
          loading: false,
          connected: true,
          error: null,
          loadedAt: now(),
        });
        syncDetail();
        return next;
      } catch (error) {
        return set({
          ...model,
          loading: false,
          connected: false,
          error: toPanelError(error),
        });
      }
    },

    selectRun: async (runId) => {
      if (disposed) return model;
      // Keep a detail already loaded for this run while refreshing it: no flicker on a poll.
      const keep = model.detail?.id === runId ? model.detail : null;
      set({ ...model, selectedRunId: runId, detail: keep, detailLoading: true, error: null });
      try {
        const detail = await options.client.getRun(runId);
        if (disposed || model.selectedRunId !== runId) return model;
        return set({ ...model, detail, detailLoading: false, error: null });
      } catch (error) {
        if (disposed || model.selectedRunId !== runId) return model;
        const failure = toPanelError(error);
        if (failure.code === "run_unknown") {
          // The run was removed (or never existed): go back to the list instead of a dead page.
          return set({
            ...model,
            selectedRunId: null,
            detail: null,
            detailLoading: false,
            error: failure,
          });
        }
        return set({ ...model, detailLoading: false, error: failure });
      }
    },

    closeRun: () => set({ ...model, selectedRunId: null, detail: null, detailLoading: false }),

    setFilter: (filter) => set({ ...model, filter }),

    start: () => {
      if (disposed || subscription !== undefined) return;
      subscription = subscribeRuns({
        openEvents,
        onSnapshot: (runs) => {
          const sorted = sortRuns(runs);
          set({
            ...model,
            runs: sorted,
            gates: pendingGates(sorted),
            connected: true,
            error: null,
            loadedAt: now(),
          });
          syncDetail();
        },
        onRun: (run) => {
          const runs = mergeRun(model.runs, run);
          set({ ...model, runs, gates: pendingGates(runs), loadedAt: now() });
          syncDetail();
        },
        onStatus: (status, error) => {
          if (status === "open") set({ ...model, connected: true });
          else if (status === "error" && error !== undefined) set({ ...model, error });
          else if (status === "closed") set({ ...model, connected: false });
        },
        onReconnect: () => {
          // The server may have advanced while the plugin was disconnected: full re-fetch.
          void store.load();
        },
        ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      });
    },

    stop: () => {
      subscription?.close();
      subscription = undefined;
      set({ ...model, connected: false });
    },

    decideGate: async (action) =>
      decideGateOnce(model, action, {
        client: options.client,
        now,
        onModel: (next) => {
          set(next);
        },
      }),

    cancelRun: async (runId) =>
      runBusy(runId, async () => {
        await options.client.cancelRun?.(runId);
      }),

    retryStep: async (runId, stepId) =>
      runBusy(runId, async () => {
        if (options.client.retryStep === undefined) {
          throw new PluginRpcError("internal_error", "retry is not available on this client", 0);
        }
        await options.client.retryStep(runId, stepId);
      }),

    removeRun: async (runId) =>
      runBusy(runId, async () => {
        if (options.client.removeRun === undefined) {
          throw new PluginRpcError("internal_error", "remove is not available on this client", 0);
        }
        await options.client.removeRun(runId);
      }),

    startRun: async (request) => {
      if (model.starting) return { model };
      set({ ...model, starting: true, error: null });
      try {
        if (options.client.startRun === undefined) {
          throw new PluginRpcError("internal_error", "start is not available on this client", 0);
        }
        const started = await options.client.startRun(request);
        if (disposed) return { model, started };
        await store.load();
        return { model: set({ ...model, starting: false }), started };
      } catch (error) {
        const failure = toPanelError(error);
        return { model: set({ ...model, starting: false, error: failure }), error: failure };
      }
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription?.close();
      subscription = undefined;
      listeners.clear();
      options.client.close?.();
    },
  };

  return store;
}
