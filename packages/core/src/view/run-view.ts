/**
 * Run views (spec FR6/FR8/FR9/FR10): the GitHub-CI-shaped projection every Argos client renders.
 *
 * Pure: same model in, same view out (snapshot-testable, no DOM, no clock of its own — `now` is an
 * argument). The list groups runs by playbook because a schedule fires the same playbook every
 * hour, and the run page renders one row per step plus that step's log.
 */

import type {
  GateSummary,
  HistoryEvent,
  RunDetail,
  RunStatus,
  RunSummary,
  StepDetailSummary,
  StepKind,
  StepStatus,
  StepSummary,
} from "../rpc/contracts.js";
import type { PanelError } from "./errors.js";
import { formatDateTime, formatDuration, formatRelative, formatScalar, formatUsage } from "./format.js";
import { gateKey, gateView, type GateView } from "./gates.js";
import {
  isActiveRun,
  RUN_FILTER_LABELS,
  RUN_FILTERS,
  RUN_STATUS_GLYPHS,
  RUN_STATUS_LABELS,
  runMatchesFilter,
  runStatusTone,
  STEP_KIND_LABELS,
  STEP_STATUS_GLYPHS,
  STEP_STATUS_LABELS,
  stepStatusTone,
  type RunFilter,
  type StatusTone,
} from "./labels.js";
import {
  attemptViews,
  buildRunLog,
  buildStepLog,
  compactUsage,
  logText,
  outputViews,
  type StepAttemptView,
  type StepLogEntry,
  type StepOutputView,
} from "./step-log.js";
import { pluralized, shortId } from "./format.js";

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
  /** Compact accounting of the step's attempts: `$0.42`, else `120 in · 3k out`; null if none. */
  readonly usageLabel: string | null;
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

function detailFields(step: StepSummary): StepDetailFields {
  if (!("attempts" in step)) return { attempts: [], outputs: [] };
  const detailed = step as StepDetailSummary;
  return {
    attempts: attemptViews(detailed.attempts ?? []),
    outputs: outputViews(detailed.outputs),
    ...(detailed.outcome === undefined ? {} : { outcome: detailed.outcome }),
  };
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
  /** FR8: the non-default substrate this run used (`hc`); absent when it ran on `paseo`. */
  readonly executor?: string;
  /** Fork provenance (S-FR1): the parent run and the step this one was forked at. */
  readonly forkedFrom?: { readonly runId: string; readonly stepId: string };
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
  /** Workflow accounting of every agent step (`$0.67 · 240 in · 6k out`); null when none. */
  readonly usageLabel: string | null;
  /** Compact cost/token total for a list row (`$0.67`, else `240 in · 6k out`). */
  readonly costLabel: string | null;
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
  readonly filters: readonly {
    readonly id: RunFilter;
    readonly label: string;
    readonly count: number;
  }[];
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

/**
 * The state `panelView` needs. Both clients' stores satisfy it structurally, so the projection does
 * not depend on a store implementation.
 */
export interface PanelViewInput {
  readonly runs: readonly RunSummary[];
  readonly gates: readonly GateSummary[];
  readonly inFlight: readonly string[];
  readonly busyRuns: readonly string[];
  readonly detail: RunDetail | null;
  readonly selectedRunId: string | null;
  readonly detailLoading: boolean;
  readonly filter: RunFilter;
  readonly loading: boolean;
  readonly connected: boolean;
  readonly error: PanelError | null;
}

/** `updatedAt` desc, then id, so the list is stable even when two runs share a timestamp. */
export function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort(
    (left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : -1),
  );
}

/** Every pending gate of every run (the actionable list). */
export function pendingGates(runs: readonly RunSummary[]): GateSummary[] {
  return runs.flatMap((run) => run.gates.filter((gate) => gate.status === "pending"));
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
    step.endedAt ??
    (step.status === "running" ? Math.max(context.now, step.startedAt ?? 0) : step.startedAt);
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
      step.startedAt === undefined || end === undefined ? "" : formatDuration(end - step.startedAt),
    usageLabel: compactUsage(step.usage),
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

function runDetail(run: RunSummary, gates: readonly GateView[]): string {
  // A skipped step counts as "done" here: `when: false` settles it, it does not hold the run up.
  const done = run.steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
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
  // Usage follows the same rule: a detail fetch is newer than the list snapshot.
  const effective = detail?.id === run.id ? detail : run;
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
    // FR8: the list carries it only for a non-default substrate, so a paseo row renders as before.
    ...(run.executor === undefined ? {} : { executor: run.executor }),
    ...(run.forkedFrom === undefined
      ? {}
      : { forkedFrom: { runId: run.forkedFrom.runId, stepId: run.forkedFrom.stepId } }),
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
    usageLabel: formatUsage(effective.usage),
    costLabel: compactUsage(effective.usage),
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
export function panelView(
  model: PanelViewInput,
  options: { readonly now?: number } = {},
): PanelView {
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
