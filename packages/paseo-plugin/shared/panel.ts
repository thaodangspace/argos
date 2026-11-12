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
  type RunStatus,
  type RunSummary,
  type Scalar,
  type StartRunRequest,
  type StartRunResponse,
  type StepKind,
  type StepStatus,
} from "argos-core/rpc/contracts";

import {
  PluginRpcError,
  type EventStreamHandle,
  type OpenEvents,
  type PanelRpc,
  type SseFrame,
} from "./rpc-client";

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
    const loaded = await store.load();
    return set({ ...loaded, busyRuns: without(loaded.busyRuns, runId) });
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
        return set({
          ...model,
          runs: loaded.runs,
          gates: loaded.gates,
          loading: false,
          connected: true,
          error: null,
          loadedAt: now(),
        });
      } catch (error) {
        return set({
          ...model,
          loading: false,
          connected: false,
          error: toPanelError(error),
        });
      }
    },

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
        },
        onRun: (run) => {
          const runs = mergeRun(model.runs, run);
          set({ ...model, runs, gates: pendingGates(runs), loadedAt: now() });
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
        const loaded = await store.load();
        return { model: set({ ...loaded, starting: false }), started };
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

/** One step row: label + tone + attempts, no prompt (the contract never carries one). */
export interface StepView {
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly kindLabel: string;
  readonly status: StepStatus;
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly attemptCount: number;
  readonly errorCode?: string;
  /** The run is finished and this step failed (or was interrupted by a cancel): offer Retry. */
  readonly retryable: boolean;
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

export interface RunView {
  readonly id: string;
  readonly playbookId: string;
  readonly status: RunStatus;
  readonly statusLabel: string;
  readonly tone: StatusTone;
  readonly updatedAt: number;
  readonly updatedLabel: string;
  /** `2/3 steps completed` plus the current step or pending gate. */
  readonly detail: string;
  readonly steps: readonly StepView[];
  readonly gates: readonly GateView[];
  readonly active: boolean;
  /** A cancel, retry, or remove for this run is in flight: disable its buttons. */
  readonly cancelling: boolean;
  /** The run is finished, so it can be removed from Argos. */
  readonly removable: boolean;
}

export interface PanelView {
  readonly runs: readonly RunView[];
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

function stepView(step: RunSummary["steps"][number], runActive: boolean): StepView {
  return {
    id: step.id,
    title: step.title === "" ? step.id : step.title,
    kind: step.kind,
    kindLabel: STEP_KIND_LABELS[step.kind],
    status: step.status,
    statusLabel: STEP_STATUS_LABELS[step.status],
    tone: stepStatusTone(step.status),
    attemptCount: step.attemptCount,
    retryable: !runActive && step.status === "failed",
    ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
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
  const done = run.steps.filter((step) => step.status === "completed").length;
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

/** One run as the panel renders it. `gates` are every gate of the run, pending and decided. */
export function runView(
  run: RunSummary,
  options: { readonly inFlight?: readonly string[]; readonly busyRuns?: readonly string[]; readonly gates?: readonly GateSummary[] } = {},
): RunView {
  const inFlight = options.inFlight ?? [];
  const busyRuns = options.busyRuns ?? [];
  const gates = (options.gates ?? run.gates).map((gate) =>
    gateView(gate, { deciding: inFlight.includes(gateKey(gate.runId, gate.gateId)) }),
  );
  return {
    id: run.id,
    playbookId: run.playbookId,
    status: run.status,
    statusLabel: RUN_STATUS_LABELS[run.status],
    tone: runStatusTone(run.status),
    updatedAt: run.updatedAt,
    updatedLabel: new Date(run.updatedAt).toISOString(),
    detail: runDetail(run, gates),
    steps: run.steps.map((step) => stepView(step, isActiveRun(run.status))),
    gates,
    active: isActiveRun(run.status),
    cancelling: busyRuns.includes(run.id),
    removable: !isActiveRun(run.status),
  };
}

/** Map the model to labels/tones. Pure: same model in, same view out (snapshot-testable). */
export function panelView(model: PanelModel): PanelView {
  const runs = model.runs.map((run) =>
    runView(run, { inFlight: model.inFlight, busyRuns: model.busyRuns }),
  );
  const gates = model.gates.map((gate) =>
    gateView(gate, { deciding: model.inFlight.includes(gateKey(gate.runId, gate.gateId)) }),
  );
  const running = runs.filter((run) => run.status === "running").length;
  const pending = gates.filter((gate) => gate.status === "pending").length;
  const statusLabel = model.error !== null ? "Argos server not running" : model.connected ? "Live" : "Connecting";
  return {
    runs,
    gates,
    running,
    pendingGates: pending,
    heading:
      runs.length === 0
        ? "No Argos runs yet"
        : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${running} running · ${pending} gate${pending === 1 ? "" : "s"}`,
    statusLabel,
    statusTone: model.error !== null ? "danger" : model.connected ? "success" : "warning",
    empty: runs.length === 0,
    loading: model.loading,
    error: model.error,
    connected: model.connected,
  };
}

