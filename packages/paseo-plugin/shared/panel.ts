/**
 * Panel model (FR28) — pure state + subscriptions, no React, no JSX, no theme.
 *
 * The panel is a *projection* of what `argos serve` reports, never a second state machine (D2,
 * plan Phase 9 step 3). Three rules keep it that way:
 *
 * 1. {@link loadPanel} and {@link subscribeRuns} are the only readers; the server's SSE stream is
 *    the source of truth (an `event: snapshot` frame is a full list, an `event: run` frame is one
 *    changed run).
 * 2. {@link decideGateOnce} performs **exactly one** `decideGate` call per user action, records the
 *    gate in `inFlight` so the buttons disable, and treats `gate_already_decided` as "refresh",
 *    never "retry".
 * 3. {@link runView}/{@link panelView} turn the model into human labels and semantic tones; the
 *    client entry maps tones to theme tokens. This module is snapshot-testable without a DOM.
 */

import {
  SSE_RUN_EVENT,
  SSE_SNAPSHOT_EVENT,
  type GateDecisionResponse,
  type GateSummary,
  type HistoryEvent,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type Scalar,
  type StartRunRequest,
  type StartRunResponse,
  type StepDetailSummary,
  type StepKind,
  type StepStatus,
  type StepSummary,
} from "@thaodangspace/argos-core/rpc/contracts";

import {
  PluginRpcError,
  type EventStreamHandle,
  type OpenEvents,
  type PanelRpc,
  type SseFrame,
} from "./rpc-client";
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatScalar,
  formatUsage,
  pluralized,
  shortId,
} from "./format";

/** Tone names the client maps onto `theme.colors` (`statusSuccess`, `statusDanger`, …). */
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

// ------------------------------------------------------------------ labels

export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting for gate",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  waiting: "Waiting for gate",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export const STEP_KIND_LABELS: Readonly<Record<StepKind, string>> = {
  agent: "agent",
  gate: "gate",
  script: "script",
  branch: "branch",
  delay: "delay",
};

export function runStatusTone(status: RunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "waiting":
      return "warning";
    case "cancelled":
    case "pending":
      return "neutral";
  }
}

export function stepStatusTone(status: StepStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "waiting":
      return "warning";
    case "ready":
    case "skipped":
    case "pending":
      return "neutral";
  }
}

/** `completed` · `failed` · `waiting` — the run statuses that allow a cancel. */
export function isActiveRun(status: RunStatus): boolean {
  return status === "running" || status === "waiting" || status === "pending";
}

/**
 * The list's status filter (GitHub CI's "Filter workflow runs"). `running` covers every run that
 * still needs a process (`pending`, `running`, `waiting`), which is what a user means by it.
 */
export type RunFilter = "all" | "running" | "failed" | "completed";

export const RUN_FILTERS: readonly RunFilter[] = ["all", "running", "failed", "completed"];

export const RUN_FILTER_LABELS: Readonly<Record<RunFilter, string>> = {
  all: "All",
  running: "Running",
  failed: "Failed",
  completed: "Completed",
};

/** True when a run belongs to the filter. `cancelled` counts as failed (it needs attention too). */
export function runMatchesFilter(status: RunStatus, filter: RunFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return isActiveRun(status);
    case "failed":
      return status === "failed" || status === "cancelled";
    case "completed":
      return status === "completed";
  }
}

// ------------------------------------------------------------------ model

export interface PanelError {
  readonly code: string;
  readonly message: string;
}

export interface PanelModel {
  /** Newest `updatedAt` first. */
  readonly runs: readonly RunSummary[];
  /** Pending gates only, in run order. */
  readonly gates: readonly GateSummary[];
  /** Gate keys (`<runId>.<gateId>`) with a decision in flight. */
  readonly inFlight: readonly string[];
  /** Run ids with a cancel, retry, or remove in flight. */
  readonly busyRuns: readonly string[];
  /** A start-run request is in flight: the start form disables. */
  readonly starting: boolean;
  /** The run whose CI page is open, or `null` on the list. */
  readonly selectedRunId: string | null;
  /** The selected run's `GET /runs/:id` payload (attempts, outputs, history), once loaded. */
  readonly detail: RunDetail | null;
  /** A detail fetch for `selectedRunId` is in flight. */
  readonly detailLoading: boolean;
  readonly filter: RunFilter;
  readonly loading: boolean;
  readonly connected: boolean;
  readonly error: PanelError | null;
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

export function gateKey(runId: string, gateId: string): string {
  return `${runId}.${gateId}`;
}

function without(values: readonly string[], value: string): string[] {
  return values.filter((entry) => entry !== value);
}

/** `updatedAt` desc, then id, so the list is stable even when two runs share a timestamp. */
export function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort(
    (left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : -1),
  );
}

/** Every pending gate of every run (the panel's actionable list). */
export function pendingGates(runs: readonly RunSummary[]): GateSummary[] {
  return runs.flatMap((run) => run.gates.filter((gate) => gate.status === "pending"));
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

// ------------------------------------------------------------------ start form

export interface StartFormInput {
  readonly playbookId: string;
  /** Empty means "the server's default cwd". */
  readonly cwd: string;
  /** `key=value` per line, or one JSON object (`{"ticket": 42}`) for typed values. */
  readonly inputs: string;
}

export type StartFormResult =
  | { readonly ok: true; readonly request: StartRunRequest }
  | { readonly ok: false; readonly error: PanelError };

function invalidForm(message: string): StartFormResult {
  return { ok: false, error: { code: "invalid_request", message } };
}

/**
 * Turn the panel's start form into a `POST /runs` body. `key=value` lines stay strings (the
 * loader validates against the playbook's declared inputs); a JSON object keeps numbers/booleans.
 */
export function parseStartForm(form: StartFormInput): StartFormResult {
  const playbookId = form.playbookId.trim();
  if (playbookId === "") return invalidForm("playbook id is required");
  const cwd = form.cwd.trim();
  const raw = form.inputs.trim();
  const inputs: Record<string, Scalar> = {};
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalidForm("inputs are not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidForm("inputs JSON must be an object");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return invalidForm(`input "${key}" must be a string, number or boolean`);
      }
      inputs[key] = value;
    }
  } else if (raw !== "") {
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const eq = line.indexOf("=");
      const key = eq === -1 ? "" : line.slice(0, eq).trim();
      if (key === "") return invalidForm(`expected key=value, got "${line.trim()}"`);
      inputs[key] = line.slice(eq + 1).trim();
    }
  }
  return {
    ok: true,
    request: {
      playbookId,
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      ...(cwd === "" ? {} : { cwd }),
    },
  };
}

export interface StartRunOutcome {
  readonly model: PanelModel;
  readonly started?: StartRunResponse;
  readonly error?: PanelError;
}

// ------------------------------------------------------------------ store

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

// ------------------------------------------------------------------ views

/** One launch attempt as the step log renders it. */
export interface StepAttemptView {
  readonly n: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationLabel: string;
  readonly target?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly usageLabel: string | null;
  readonly running: boolean;
}

/** One declared output of a step (a script's `stdout`, an agent's schema output). */
export interface StepOutputView {
  readonly name: string;
  readonly value: string;
  /** `value` split on newlines: the log pane prints one line per entry. */
  readonly lines: readonly string[];
}

/** One line of the step log (or of the run log). */
export interface StepLogEntry {
  readonly at: number | null;
  readonly timeLabel: string;
  readonly text: string;
  readonly tone: StatusTone;
}

/** One step row: label + tone + duration, and — on the run page — its log. No prompt. */
export interface StepView {
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly kindLabel: string;
  readonly status: StepStatus;
  readonly statusLabel: string;
  /** A one-column glyph (`✓`, `✕`, `●`, …) so a row scans without color. */
  readonly glyph: string;
  readonly tone: StatusTone;
  readonly attemptCount: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationLabel: string;
  readonly errorCode?: string;
  readonly outcome?: string;
  readonly attempts: readonly StepAttemptView[];
  readonly outputs: readonly StepOutputView[];
  readonly gates: readonly GateView[];
  readonly log: readonly StepLogEntry[];
  /** The log as copyable text, one line per entry. */
  readonly logText: string;
  /** True when the log has more than the header: the row offers an expand affordance. */
  readonly hasLog: boolean;
  /** The run is finished and this step failed (or was interrupted by a cancel): offer Retry. */
  readonly retryable: boolean;
}

/** `GET /runs/:id` fields a summary does not carry (older servers may still omit them). */
interface StepDetailFields {
  readonly attempts: readonly StepAttemptView[];
  readonly outputs: readonly StepOutputView[];
  readonly outcome?: string;
}

/** One choice button of a pending gate. */
export interface GateChoiceView {
  readonly id: string;
  readonly label: string;
  readonly comment: "none" | "optional" | "required";
  readonly tone: StatusTone;
}

export interface GateView {
  readonly key: string;
  readonly runId: string;
  readonly gateId: string;
  readonly stepId: string;
  readonly kind: GateSummary["kind"];
  readonly question: string;
  readonly status: GateSummary["status"];
  readonly choices: readonly GateChoiceView[];
  /** A decision for this gate is in flight: disable every button. */
  readonly deciding: boolean;
  readonly decision?: string;
}

/** One finished (or pending) after-task of a run. */
export interface AfterView {
  readonly id: string;
  readonly title: string;
  readonly trigger: "auto" | "manual";
  readonly status: string;
  readonly tone: StatusTone;
}

/** One segment of the run's step progress bar. */
export interface StepProgressView {
  readonly id: string;
  readonly label: string;
  readonly status: StepStatus;
  readonly tone: StatusTone;
}

export interface RunView {
  readonly id: string;
  /** The GitHub-CI-style short id (`#01M798D7`); the full id is in the tooltip. */
  readonly runIdShort: string;
  readonly playbookId: string;
  readonly status: RunStatus;
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly glyph: string;
  readonly createdAt: number;
  readonly createdLabel: string;
  readonly updatedAt: number;
  readonly updatedLabel: string;
  readonly updatedRelative: string;
  /** `createdAt` → `updatedAt` (or now, for a live run). */
  readonly durationLabel: string;
  /** `manual`, or `schedule <id>` (FR8.2 provenance). */
  readonly triggerLabel: string;
  readonly scheduleId?: string;
  readonly cwd: string;
  readonly worktree?: string;
  readonly inputs: readonly { readonly name: string; readonly value: string }[];
  readonly after: readonly AfterView[];
  /** `2/3 steps completed` plus the current step or pending gate. */
  readonly detail: string;
  readonly stepCount: number;
  readonly completedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly progress: readonly StepProgressView[];
  readonly steps: readonly StepView[];
  readonly gates: readonly GateView[];
  readonly active: boolean;
  /** A cancel, retry, or remove for this run is in flight: disable its buttons. */
  readonly cancelling: boolean;
  /** The run is finished, so it can be removed from Argos. */
  readonly removable: boolean;
}

/** One playbook's runs, newest first: the list groups by workflow so a schedule does not flood it. */
export interface WorkflowGroupView {
  readonly playbookId: string;
  readonly latest: RunView;
  readonly runs: readonly RunView[];
  readonly total: number;
  readonly active: number;
  readonly failed: number;
  readonly pendingGates: number;
}

/** The open run's page: the run view plus the detail-only log data. */
export interface RunDetailView {
  readonly run: RunView;
  /** The detail fetch is in flight (the page renders the summary meanwhile). */
  readonly loading: boolean;
  readonly history: readonly HistoryEvent[];
  /** Run-level log lines (`run_started`, `settle`, `finish`, `after_*`, …). */
  readonly runLog: readonly StepLogEntry[];
}

export interface PanelView {
  readonly runs: readonly RunView[];
  /** Runs the current filter keeps, grouped by playbook. */
  readonly groups: readonly WorkflowGroupView[];
  readonly filter: RunFilter;
  readonly filters: readonly { readonly id: RunFilter; readonly label: string; readonly count: number }[];
  readonly visibleCount: number;
  readonly selected: RunDetailView | null;
  readonly gates: readonly GateView[];
  readonly running: number;
  readonly pendingGates: number;
  readonly heading: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly empty: boolean;
  readonly loading: boolean;
  readonly error: PanelError | null;
  readonly connected: boolean;
}

const CHOICE_TONES: Readonly<Record<string, StatusTone>> = {
  primary: "accent",
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "danger",
};

function choiceTone(choice: GateSummary["choices"][string]): StatusTone {
  return choice.color === undefined ? "accent" : (CHOICE_TONES[choice.color] ?? "accent");
}

// ------------------------------------------------------------------ glyphs

export const RUN_STATUS_GLYPHS: Readonly<Record<RunStatus, string>> = {
  pending: "○",
  running: "●",
  waiting: "◔",
  completed: "✓",
  failed: "✕",
  cancelled: "⊘",
};

export const STEP_STATUS_GLYPHS: Readonly<Record<StepStatus, string>> = {
  pending: "○",
  ready: "◌",
  running: "●",
  waiting: "◔",
  completed: "✓",
  failed: "✕",
  skipped: "–",
};

// ------------------------------------------------------------------ step log

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  completed: "completed",
  failed: "failed",
  timeout: "timed out",
  cancelled: "cancelled",
};

function historyTone(type: HistoryEvent["type"]): StatusTone {
  switch (type) {
    case "task_error":
      return "danger";
    case "gate":
      return "warning";
    case "gate_decided":
      return "success";
    case "dispatch":
    case "retry":
    case "script_repinned":
      return "accent";
    case "finish":
    case "after_start":
      return "success";
    default:
      return "neutral";
  }
}

/** One history event as a log line. The vocabulary is fixed, so a new type must be added here. */
export function historyText(event: HistoryEvent): string {
  const detail = event.detail ?? "";
  const suffix = detail === "" ? "" : `: ${detail}`;
  switch (event.type) {
    case "run_started":
      return `Run started${suffix}`;
    case "select":
      return "Selecting ready steps";
    case "dispatch":
      return `Dispatched${event.attempt === null ? "" : ` (attempt ${event.attempt})`}`;
    case "settle":
      return `Settled${suffix}`;
    case "gate":
      return `Gate opened${suffix}`;
    case "gate_decided":
      return `Gate decided${suffix}`;
    case "finish":
      return `Run finished${suffix}`;
    case "effect_skipped":
      return `Effect skipped${suffix}`;
    case "task_error":
      return `Task error${suffix}`;
    case "after_queued":
      return `After-task queued${suffix}`;
    case "after_start":
      return `After-task started${suffix}`;
    case "retry":
      return `Retried${suffix}`;
    case "script_repinned":
      return `Script repinned${suffix}`;
  }
}

interface PendingLogEntry {
  readonly at: number | null;
  readonly sortAt: number;
  readonly text: string;
  readonly tone: StatusTone;
}

function pendingEntry(
  at: number | null,
  text: string,
  tone: StatusTone,
  offset = 0,
): PendingLogEntry {
  return { at, sortAt: (at ?? Number.MAX_SAFE_INTEGER) + offset, text, tone };
}

/** A line that belongs to the entry before it (an output's second line): no timestamp of its own. */
function continuationEntry(base: number | null, text: string, tone: StatusTone): PendingLogEntry {
  return {
    at: null,
    sortAt: (base ?? Number.MAX_SAFE_INTEGER) + 0.5,
    text,
    tone,
  };
}

function historyEntry(event: HistoryEvent): PendingLogEntry {
  return pendingEntry(event.at, historyText(event), historyTone(event.type));
}

/** Log entries carry a display time; a continuation line (an output's second line) has none. */
function toLogEntries(entries: readonly PendingLogEntry[]): StepLogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sortAt - right.entry.sortAt || left.index - right.index)
    .map(({ entry }) => ({
      at: entry.at,
      timeLabel: formatClock(entry.at),
      text: entry.text,
      tone: entry.tone,
    }));
}

function attemptViews(attempts: readonly StepDetailSummary["attempts"][number][]): StepAttemptView[] {
  return attempts.map((attempt) => {
    const ended = attempt.endedAt;
    return {
      n: attempt.n,
      startedAt: attempt.startedAt,
      ...(ended === undefined ? {} : { endedAt: ended }),
      durationLabel: ended === undefined ? "running" : formatDuration(ended - attempt.startedAt),
      ...(attempt.target === undefined ? {} : { target: attempt.target }),
      ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
      usageLabel: formatUsage(attempt.usage),
      running: ended === undefined,
    };
  });
}

function outputViews(outputs: StepDetailSummary["outputs"]): StepOutputView[] {
  if (outputs === undefined) return [];
  return Object.entries(outputs).map(([name, value]) => {
    const text = formatScalar(value);
    return { name, value: text, lines: text.replace(/\n$/, "").split("\n") };
  });
}

/**
 * The step's log, built from the detail projection alone: its history events, its attempts (with
 * target + usage), its declared outputs, its outcome/error, and the gates opened for it.
 *
 * Agent transcripts are never stored by Argos, so an agent step's log stops at its declared
 * outputs; a script step's `stdout`/`stderr` outputs are the console tail.
 */
export function buildStepLog(input: {
  readonly step: StepSummary;
  readonly history: readonly HistoryEvent[];
  readonly gates: readonly GateSummary[];
  readonly attempts: readonly StepAttemptView[];
  readonly outputs: readonly StepOutputView[];
  readonly outcome?: string;
}): StepLogEntry[] {
  const entries: PendingLogEntry[] = [];
  for (const event of input.history) {
    if (event.stepId !== input.step.id) continue;
    if (event.type === "select") continue;
    entries.push(historyEntry(event));
  }

  const lastEnded = input.step.endedAt ?? input.step.startedAt ?? null;
  for (const attempt of input.attempts) {
    entries.push(
      pendingEntry(
        attempt.startedAt,
        `Attempt ${attempt.n} started${attempt.target === undefined ? "" : ` on ${attempt.target}`}`,
        "accent",
      ),
    );
    if (attempt.endedAt !== undefined) {
      const word = attempt.outcome === undefined ? "finished" : (OUTCOME_WORDS[attempt.outcome] ?? attempt.outcome);
      const code = attempt.errorCode === undefined ? "" : ` (${attempt.errorCode})`;
      const failed = attempt.outcome === "failed" || attempt.outcome === "timeout" || attempt.outcome === "cancelled";
      entries.push(
        pendingEntry(
          attempt.endedAt,
          `Attempt ${attempt.n} ${word} in ${attempt.durationLabel}${code}`,
          failed ? "danger" : "success",
        ),
      );
    }
    if (attempt.usageLabel !== null) {
      entries.push(pendingEntry(attempt.endedAt ?? attempt.startedAt, `Usage: ${attempt.usageLabel}`, "neutral"));
    }
  }

  for (const output of input.outputs) {
    entries.push(pendingEntry(lastEnded, `Output ${output.name}:`, "neutral"));
    for (const line of output.lines) entries.push(continuationEntry(lastEnded, line, "neutral"));
  }

  if (input.outcome !== undefined) {
    entries.push(pendingEntry(lastEnded, `Outcome: ${input.outcome}`, "neutral", 0.5));
  }
  if (input.step.errorCode !== undefined) {
    entries.push(pendingEntry(lastEnded, `Error: ${input.step.errorCode}`, "danger", 0.5));
  }

  for (const gate of input.gates) {
    if (gate.stepId !== input.step.id) continue;
    const decided = gate.status === "decided";
    entries.push(
      pendingEntry(
        decided ? (gate.decidedAt ?? null) : lastEnded,
        `Gate ${gate.gateId} (${gate.kind}) ${gate.status}${gate.question === "" ? "" : `: ${gate.question}`}`,
        decided ? "success" : "warning",
      ),
    );
    if (gate.decision !== undefined) {
      const by = gate.decidedBy === undefined ? "" : ` by ${gate.decidedBy}`;
      const via = gate.decidedVia === undefined ? "" : ` via ${gate.decidedVia}`;
      entries.push(pendingEntry(gate.decidedAt ?? lastEnded, `Decision: ${gate.decision}${by}${via}`, "success"));
    }
    if (gate.comment !== undefined && gate.comment !== "") {
      entries.push(pendingEntry(null, `Comment: ${gate.comment}`, "neutral"));
    }
  }

  return toLogEntries(entries);
}

/** `✓ 01:49:00  Attempt 1 started on claude/opus` — the copyable text of a log. */
export function logText(entries: readonly StepLogEntry[]): string {
  return entries
    .map((entry) => (entry.at === null ? `        ${entry.text}` : `${entry.timeLabel}  ${entry.text}`))
    .join("\n");
}

/** Run-level lines: everything that is not tied to one step. */
export function buildRunLog(history: readonly HistoryEvent[]): StepLogEntry[] {
  return toLogEntries(
    history
      .filter((event) => event.stepId === null && event.type !== "select")
      .map((event) => historyEntry(event)),
  );
}

function detailFields(step: StepSummary): StepDetailFields {
  if (!("attempts" in step)) return { attempts: [], outputs: [] };
  const detailed = step as StepDetailSummary;
  return {
    attempts: attemptViews(detailed.attempts ?? []),
    outputs: outputViews(detailed.outputs),
    ...(detailed.outcome === undefined ? {} : { outcome: detailed.outcome }),
  };
}

function stepView(
  step: StepSummary,
  runActive: boolean,
  context: {
    readonly history?: readonly HistoryEvent[];
    readonly gates?: readonly GateSummary[];
    readonly now: number;
  },
): StepView {
  const detail = detailFields(step);
  const gates = (context.gates ?? []).filter((gate) => gate.stepId === step.id);
  const log =
    context.history === undefined
      ? []
      : buildStepLog({
          step,
          history: context.history,
          gates,
          attempts: detail.attempts,
          outputs: detail.outputs,
          ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
        });
  const end =
    step.endedAt ?? (step.status === "running" ? Math.max(context.now, step.startedAt ?? 0) : step.startedAt);
  return {
    id: step.id,
    title: step.title === "" ? step.id : step.title,
    kind: step.kind,
    kindLabel: STEP_KIND_LABELS[step.kind],
    status: step.status,
    statusLabel: STEP_STATUS_LABELS[step.status],
    glyph: STEP_STATUS_GLYPHS[step.status],
    tone: stepStatusTone(step.status),
    attemptCount: step.attemptCount,
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.endedAt === undefined ? {} : { endedAt: step.endedAt }),
    durationLabel:
      step.startedAt === undefined || end === undefined
        ? ""
        : formatDuration(end - step.startedAt),
    retryable: !runActive && step.status === "failed",
    ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
    ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
    attempts: detail.attempts,
    outputs: detail.outputs,
    gates: gates.map((gate) => gateView(gate)),
    log,
    logText: logText(log),
    hasLog: log.length > 0,
  };
}

export function gateView(
  gate: GateSummary,
  options: { readonly deciding?: boolean } = {},
): GateView {
  return {
    key: gateKey(gate.runId, gate.gateId),
    runId: gate.runId,
    gateId: gate.gateId,
    stepId: gate.stepId,
    kind: gate.kind,
    question: gate.question,
    status: gate.status,
    choices: Object.entries(gate.choices).map(([id, choice]) => ({
      id,
      label: choice.label,
      comment: choice.comment,
      tone: choiceTone(choice),
    })),
    deciding: options.deciding === true,
    ...(gate.decision === undefined ? {} : { decision: gate.decision }),
  };
}

function runDetail(run: RunSummary, gates: readonly GateView[]): string {
  // A skipped step counts as "done" here: `when: false` settles it, it does not hold the run up.
  const done = run.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const running = run.steps.find((step) => step.status === "running");
  const pending = gates.filter((gate) => gate.status === "pending");
  if (pending.length > 0) {
    return `${done}/${run.steps.length} steps · gate ${pending[0]?.gateId ?? ""} waiting`;
  }
  if (running !== undefined) {
    return `${done}/${run.steps.length} steps · ${running.title || running.id} running`;
  }
  if (run.status === "failed") {
    const failed = run.steps.find((step) => step.status === "failed");
    return `${done}/${run.steps.length} steps · ${failed?.errorCode ?? "failed"}`;
  }
  if (run.status === "completed") return `${run.steps.length}/${run.steps.length} steps completed`;
  return `${done}/${run.steps.length} steps`;
}

function afterViews(run: RunSummary): AfterView[] {
  const tones: Readonly<Record<string, StatusTone>> = {
    pending: "neutral",
    running: "accent",
    completed: "success",
    failed: "danger",
    skipped: "neutral",
  };
  return run.after.map((entry) => ({
    id: entry.id,
    title: entry.title === "" ? entry.id : entry.title,
    trigger: entry.trigger,
    status: entry.status,
    tone: tones[entry.status] ?? "neutral",
  }));
}

export function triggerLabel(run: RunSummary): string {
  if (run.trigger === undefined) return "manual";
  return `schedule ${run.trigger.scheduleId} (${run.trigger.reason.replace("_", " ")})`;
}

/** `RunDetail` is a `RunSummary` plus `history`: a caller may hand us either. */
function asRunDetail(run: RunSummary): RunDetail | undefined {
  const candidate = run as Partial<RunDetail>;
  return Array.isArray(candidate.history) ? (candidate as RunDetail) : undefined;
}

/** One run as the list and the run page render it. */
export function runView(
  run: RunSummary,
  options: {
    readonly inFlight?: readonly string[];
    readonly busyRuns?: readonly string[];
    readonly gates?: readonly GateSummary[];
    readonly detail?: RunDetail;
    readonly now?: number;
  } = {},
): RunView {
  const inFlight = options.inFlight ?? [];
  const busyRuns = options.busyRuns ?? [];
  const now = options.now ?? Date.now();
  const detail = options.detail ?? asRunDetail(run);
  // The detail projection is fresher than the list entry and carries attempts/outputs/history.
  const steps = detail?.id === run.id ? detail.steps : run.steps;
  // Gates come from the gate documents, which the list projection always carries and which are
  // fresher than the mirrored record (a decision lands before the next settle).
  const gateSummaries = options.gates ?? run.gates;

  const gates = gateSummaries.map((gate) =>
    gateView(gate, { deciding: inFlight.includes(gateKey(gate.runId, gate.gateId)) }),
  );
  const active = isActiveRun(run.status);
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const skippedCount = steps.filter((step) => step.status === "skipped").length;
  const failedCount = steps.filter((step) => step.status === "failed").length;
  return {
    id: run.id,
    runIdShort: shortId(run.id),
    playbookId: run.playbookId,
    status: run.status,
    statusLabel: RUN_STATUS_LABELS[run.status],
    tone: runStatusTone(run.status),
    glyph: RUN_STATUS_GLYPHS[run.status],
    createdAt: run.createdAt,
    createdLabel: formatDateTime(run.createdAt),
    updatedAt: run.updatedAt,
    updatedLabel: new Date(run.updatedAt).toISOString(),
    updatedRelative: formatRelative(run.updatedAt, now),
    durationLabel: formatDuration((active ? now : run.updatedAt) - run.createdAt),
    triggerLabel: triggerLabel(run),
    ...(run.trigger === undefined ? {} : { scheduleId: run.trigger.scheduleId }),
    cwd: run.cwd,
    ...(run.worktree === undefined ? {} : { worktree: run.worktree.path }),
    inputs: Object.entries(run.inputs).map(([name, value]) => ({
      name,
      value: formatScalar(value),
    })),
    after: afterViews(run),
    detail: runDetail(run, gates),
    stepCount: steps.length,
    completedCount,
    skippedCount,
    failedCount,
    progress: steps.map((step) => ({
      id: step.id,
      label: step.title === "" ? step.id : step.title,
      status: step.status,
      tone: stepStatusTone(step.status),
    })),
    steps: steps.map((step) =>
      stepView(step, active, {
        ...(detail === undefined ? {} : { history: detail.history }),
        gates: gateSummaries,
        now,
      }),
    ),
    gates,
    active,
    cancelling: busyRuns.includes(run.id),
    removable: !active,
  };
}

/**
 * Group runs by playbook, newest group first, runs newest first inside. A schedule fires the same
 * playbook every hour, so a flat list is a wall of one name; grouping is the CI-style answer.
 */
export function groupRuns(runs: readonly RunView[]): WorkflowGroupView[] {
  const groups = new Map<string, RunView[]>();
  for (const run of runs) {
    const existing = groups.get(run.playbookId);
    if (existing === undefined) groups.set(run.playbookId, [run]);
    else existing.push(run);
  }
  const views: WorkflowGroupView[] = [];
  for (const [playbookId, entries] of groups) {
    const latest = entries[0];
    if (latest === undefined) continue;
    views.push({
      playbookId,
      latest,
      runs: entries,
      total: entries.length,
      active: entries.filter((run) => run.active).length,
      failed: entries.filter((run) => run.status === "failed" || run.status === "cancelled").length,
      pendingGates: entries.reduce(
        (count, run) => count + run.gates.filter((gate) => gate.status === "pending").length,
        0,
      ),
    });
  }
  return views.sort(
    (left, right) =>
      right.latest.updatedAt - left.latest.updatedAt ||
      (left.playbookId < right.playbookId ? 1 : -1),
  );
}

/** Map the model to labels/tones. Pure: same model in, same view out (snapshot-testable). */
export function panelView(model: PanelModel, options: { readonly now?: number } = {}): PanelView {
  const now = options.now ?? Date.now();
  const runs = model.runs.map((run) =>
    runView(run, {
      now,
      inFlight: model.inFlight,
      busyRuns: model.busyRuns,
      ...(model.detail?.id === run.id ? { detail: model.detail } : {}),
    }),
  );
  const gates = model.gates.map((gate) =>
    gateView(gate, { deciding: model.inFlight.includes(gateKey(gate.runId, gate.gateId)) }),
  );
  const visible = runs.filter((run) => runMatchesFilter(run.status, model.filter));
  const running = runs.filter((run) => run.status === "running").length;
  const pending = gates.filter((gate) => gate.status === "pending").length;
  const statusLabel =
    model.error !== null ? "Argos server not running" : model.connected ? "Live" : "Connecting";
  const selectedRun =
    model.selectedRunId === null ? undefined : runs.find((run) => run.id === model.selectedRunId);
  const detail =
    model.detail !== null && selectedRun !== undefined && model.detail.id === selectedRun.id
      ? model.detail
      : undefined;
  return {
    runs,
    groups: groupRuns(visible),
    filter: model.filter,
    filters: RUN_FILTERS.map((id) => ({
      id,
      label: RUN_FILTER_LABELS[id],
      count: runs.filter((run) => runMatchesFilter(run.status, id)).length,
    })),
    visibleCount: visible.length,
    selected:
      selectedRun === undefined
        ? null
        : {
            run: selectedRun,
            loading: model.detailLoading,
            history: detail?.history ?? [],
            runLog: buildRunLog(detail?.history ?? []),
          },
    gates,
    running,
    pendingGates: pending,
    heading:
      runs.length === 0
        ? "No Argos runs yet"
        : `${pluralized(runs.length, "run")} · ${running} running · ${pluralized(pending, "gate")}`,
    statusLabel,
    statusTone: model.error !== null ? "danger" : model.connected ? "success" : "warning",
    empty: runs.length === 0,
    loading: model.loading,
    error: model.error,
    connected: model.connected,
  };
}

