/**
 * Build the RPC read model from mirrored documents (FR26).
 *
 * The mirror is the complete `RunRecord`; this module projects it down to what a UI or CLI may
 * see. It never copies `ir`, a step prompt, an agent id, or a transcript: the summary is display
 * metadata and counts only, which is what keeps `GET /runs` safe to render in a panel.
 */

import type { RunRecord } from "../engine/index.js";
import { isSecretEnvName, isTerminalRunStatus } from "../engine/index.js";
import type { HistoryDocValue, RunDoc } from "../durable/mirror.js";
import type {
  AfterSummary,
  GateSummary,
  HistoryEvent,
  RunDetail,
  RunSummary,
  StepSummary,
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

/** Run inputs with credential-looking names removed (SECRET_INPUT_NAME_PATTERN). */
function publicInputs(inputs: RunRecord["inputs"]): RunSummary["inputs"] {
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
  return { ...toRunSummary(doc, gateDocuments), history: events };
}

/** True for runs that still need a process (used by `argos doctor` counters). */
export function isActiveRun(record: RunRecord): boolean {
  return !isTerminalRunStatus(record.status);
}
