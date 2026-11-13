/**
 * Build the RPC read model from mirrored documents (FR26).
 *
 * The mirror is the complete `RunRecord`; this module projects it down to what a UI or CLI may
 * see. It never copies `ir`, a step prompt, an agent id, or a transcript: the summary is display
 * metadata and counts only, which is what keeps `GET /runs` safe to render in a panel.
 */

import type { RunRecord, StepRecord } from "../engine/index.js";
import { isSecretEnvName, isTerminalRunStatus } from "../engine/index.js";
import type { HistoryDocValue, RunDoc } from "../durable/mirror.js";
import type { FireEntry, ScheduleDoc } from "../durable/schedule-docs.js";
import {
  SCHEDULE_RECENT_RUN_LIMIT,
  STEP_OUTPUT_VALUE_LIMIT,
  type AfterSummary,
  type GateSummary,
  type HistoryEvent,
  type RunDetail,
  type RunSummary,
  type ScheduleDetail,
  type ScheduleFire,
  type ScheduleSummary,
  type StepDetailSummary,
  type StepSummary,
} from "./contracts.js";

/**
 * The subset of a gate decision document the summary needs. Both the typed `GateDoc` (optional
 * fields) and the stored `GateDocValue` (`null` placeholders) satisfy it.
 */
export interface GateDocumentView {
  readonly status: "pending" | "decided";
  readonly decision?: string | null | undefined;
  readonly comment?: string | null | undefined;
  readonly decidedBy?: string | null | undefined;
  readonly decidedVia?: string | null | undefined;
  readonly decidedAt?: number | null | undefined;
}

/**
 * Run (or schedule) inputs with credential-looking names removed (SECRET_INPUT_NAME_PATTERN).
 *
 * Exported because a schedule summary needs exactly the same filter: the schedule document stores
 * its inputs in SQLite just like a run does, and the Security NFR forbids publishing them
 * unfiltered. Keeping one function means the two surfaces cannot drift.
 */
export function publicInputs(
  inputs: Readonly<Record<string, RunSummary["inputs"][string]>>,
): RunSummary["inputs"] {
  const result: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(inputs)) {
    if (isSecretEnvName(name)) continue;
    result[name] = value;
  }
  return result;
}

function stepSummaries(record: RunRecord): StepSummary[] {
  const steps: StepSummary[] = [];
  for (const definition of record.ir.steps) {
    const state = record.steps[definition.id];
    if (state === undefined) continue;
    const attempts = state.attempts;
    const first = attempts[0];
    const ended = [...attempts].reverse().find((attempt) => attempt.endedAt !== undefined);
    steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      status: state.status,
      ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
      attemptCount: attempts.length,
      ...(first === undefined ? {} : { startedAt: first.startedAt }),
      ...(ended?.endedAt === undefined ? {} : { endedAt: ended.endedAt }),
    });
  }
  return steps;
}

/** Longest output string a detail copies; the rest is replaced by a marker. */
function boundedOutput(value: StepRecord["outputs"][string]): StepRecord["outputs"][string] {
  if (typeof value !== "string" || value.length <= STEP_OUTPUT_VALUE_LIMIT) return value;
  return `${value.slice(0, STEP_OUTPUT_VALUE_LIMIT)}… (truncated)`;
}

/**
 * The detail-only step fields (`GET /runs/:id`): what the panel's per-step log renders. Declared
 * outputs go through {@link publicInputs} (a credential-shaped output name is dropped) and a long
 * string is truncated, so one detail response stays small. No prompt, agent id, or transcript.
 */
export function stepDetailSummaries(record: RunRecord): StepDetailSummary[] {
  return stepSummaries(record).map((summary) => {
    const state = record.steps[summary.id];
    if (state === undefined) return { ...summary, attempts: [] };
    const outputs = publicInputs(state.outputs);
    const bounded: Record<string, StepRecord["outputs"][string]> = {};
    for (const [name, value] of Object.entries(outputs)) bounded[name] = boundedOutput(value);
    return {
      ...summary,
      ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
      attempts: state.attempts.map((attempt) => ({
        n: attempt.n,
        startedAt: attempt.startedAt,
        ...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
        ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
        ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
        ...(attempt.target === undefined ? {} : { target: attempt.target }),
        ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
      })),
      ...(Object.keys(bounded).length === 0 ? {} : { outputs: bounded }),
    };
  });
}

/** One gate, preferring the decision document when the caller has it (fresher than the mirror). */
export function toGateSummary(
  runId: string,
  gate: RunRecord["gates"][number],
  document?: GateDocumentView,
): GateSummary {
  const decided = document?.status === "decided" || gate.status === "decided";
  const decision = document?.decision ?? gate.decision;
  const comment = document?.comment ?? gate.comment;
  const decidedBy = document?.decidedBy ?? gate.decidedBy;
  const decidedVia = document?.decidedVia ?? gate.decidedVia;
  const decidedAt = document?.decidedAt ?? gate.decidedAt;
  const choices: Record<string, GateSummary["choices"][string]> = {};
  for (const [id, choice] of Object.entries(gate.choices)) {
    choices[id] = {
      label: choice.label,
      comment: choice.comment,
      ...(choice.color === undefined ? {} : { color: choice.color }),
      ...(choice.goto === undefined ? {} : { goto: choice.goto }),
      ...(choice.outcome === undefined ? {} : { outcome: choice.outcome }),
    };
  }
  return {
    runId,
    gateId: gate.id,
    stepId: gate.stepId,
    kind: gate.kind,
    question: gate.question,
    choices,
    status: decided ? "decided" : "pending",
    ...(decision === undefined || decision === null ? {} : { decision }),
    ...(decidedBy === undefined || decidedBy === null ? {} : { decidedBy }),
    ...(decidedVia === undefined || decidedVia === null ? {} : { decidedVia }),
    ...(comment === undefined || comment === null ? {} : { comment }),
    ...(decidedAt === undefined || decidedAt === null ? {} : { decidedAt }),
  };
}

function afterSummaries(record: RunRecord): AfterSummary[] {
  const result: AfterSummary[] = [];
  for (const definition of record.ir.after) {
    const state = record.after[definition.id];
    if (state === undefined) continue;
    result.push({
      id: definition.id,
      title: definition.title,
      trigger: definition.trigger,
      status: state.status,
      ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
      ...(state.endedAt === undefined ? {} : { endedAt: state.endedAt }),
    });
  }
  return result;
}

/** Project one mirrored run document to its public summary. */
export function toRunSummary(
  doc: RunDoc,
  gateDocuments?: ReadonlyMap<string, GateDocumentView>,
): RunSummary {
  const record = doc.record;
  return {
    id: record.id,
    playbookId: record.playbookId,
    playbookHash: record.playbookHash,
    status: record.status,
    inputs: publicInputs(record.inputs),
    cwd: record.cwd,
    ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
    // FR8.2: only a scheduled run carries a trigger; a manual run omits the key entirely (the
    // summary schema is strict, and the CLI goldens must not change).
    ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
    steps: stepSummaries(record),
    gates: record.gates.map((gate) => toGateSummary(record.id, gate, gateDocuments?.get(gate.id))),
    after: afterSummaries(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    seq: record.seq,
  };
}

/** Add the bounded history to a summary (`GET /runs/:id`). */
export function toRunDetail(
  doc: RunDoc,
  history: Readonly<HistoryDocValue> | undefined,
  gateDocuments?: ReadonlyMap<string, GateDocumentView>,
): RunDetail {
  const events: HistoryEvent[] = (history?.events ?? []).map((event) => ({
    at: event.at,
    seq: event.seq,
    type: event.type,
    stepId: event.stepId,
    attempt: event.attempt,
    detail: event.detail,
  }));
  const summary = toRunSummary(doc, gateDocuments);
  return { ...summary, steps: stepDetailSummaries(doc.record), history: events };
}

/** True for runs that still need a process (used by `argos doctor` counters). */
export function isActiveRun(record: RunRecord): boolean {
  return !isTerminalRunStatus(record.status);
}

// ------------------------------------------------------------------ schedules (FR10.1)

/**
 * One stored fire entry → the wire shape. Built field by field (never spread) so a new internal
 * field cannot leak onto the wire, and the `null` placeholders a document keeps for absent values
 * are reproduced as they are: `errorCode: null` means "not an ArgosError" (FR6.2) and must not
 * become either `""` or a missing key.
 */
function fireSummary(entry: FireEntry): ScheduleFire {
  return {
    fireAt: entry.fireAt,
    at: entry.at,
    reason: entry.reason,
    status: entry.status,
    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    ...(entry.message === undefined ? {} : { message: entry.message }),
    ...(entry.count === undefined ? {} : { count: entry.count }),
    ...(entry.from === undefined ? {} : { from: entry.from }),
    ...(entry.to === undefined ? {} : { to: entry.to }),
  };
}

/**
 * Project one schedule document to its public summary (FR10.1).
 *
 * `uid`, `runIds`, and `fires` are dropped: `uid` is an internal identity, and the two logs are
 * what {@link toScheduleDetail} publishes in bounded form. `inputs` go through {@link publicInputs}
 * for the same reason a run's do (Security NFR).
 */
export function toScheduleSummary(doc: ScheduleDoc): ScheduleSummary {
  return {
    id: doc.id,
    playbookId: doc.playbookId,
    cwd: doc.cwd,
    inputs: publicInputs(doc.inputs),
    ...(doc.isolation === undefined ? {} : { isolation: doc.isolation }),
    cron: doc.cron,
    tz: doc.tz,
    overlap: doc.overlap,
    catchUp: doc.catchUp,
    keep: doc.keep,
    enabled: doc.enabled,
    generation: doc.generation,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    nextFireAt: doc.nextFireAt,
    ...(doc.lastFire === undefined ? {} : { lastFire: fireSummary(doc.lastFire) }),
    ...(doc.liveRunId === undefined ? {} : { liveRunId: doc.liveRunId }),
    consecutiveFailures: doc.consecutiveFailures,
  };
}

/**
 * A summary plus the fire log and the newest run ids (FR10.1).
 *
 * `recentRunIds` is capped at {@link SCHEDULE_RECENT_RUN_LIMIT} so one detail response stays small
 * however long a schedule has been firing; the document keeps the full list, newest first (FR9.2).
 */
export function toScheduleDetail(doc: ScheduleDoc): ScheduleDetail {
  return {
    ...toScheduleSummary(doc),
    fires: doc.fires.map(fireSummary),
    recentRunIds: doc.runIds.slice(0, SCHEDULE_RECENT_RUN_LIMIT),
  };
}
