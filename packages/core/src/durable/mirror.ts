/**
 * The read model the UI, the gate tasks, and the RPC layer consume: `argos.run.<runId>`,
 * `argos.history.<runId>`, and `argos.gate.<runId>.<gateId>`.
 *
 * Run and history documents are written **inside the same `runtime.commit()`** that stores the
 * task checkpoint (FR13), so a reader never observes a run state older than the engine's. The
 * mirror is the complete `RunRecord`; the history is an append-only, bounded event log (D16).
 *
 * The gate document (D4, FR19) is the decision channel: `argos.gate` tasks poll it every
 * {@link GATE_POLL_MS} and the host's `decideGate` writes it exactly once, inside one commit.
 * Its family key is `${runId}.${gateId}` — a run id is a ULID (no dots) and a gate id is
 * `<stepId>:<n>` (no dots either), so the key is collision-free.
 *
 * Document values are typed as JSON-compatible aliases because Chord's `defineDocFamily` requires
 * `JsonObject`. The `record` payload is the same plain JSON the engine and the checkpoint use, so
 * the cast is sound and a snapshot round-trips byte-for-byte.
 */

import type { JsonValue } from "@earendil-works/chord/json";
import { defineDocFamily, type TaskId, type Tx } from "@earendil-works/pi-durable";

import type { GateChoiceRecord, GateKind, GateRecord, RunRecord } from "../engine/index.js";

/** D4 task/document kinds. */
export const ARGOS_RUN_DOC_KIND = "argos.run";
export const ARGOS_HISTORY_DOC_KIND = "argos.history";
export const ARGOS_GATE_DOC_KIND = "argos.gate";

/** D16: the history document keeps the newest 500 events. */
export const HISTORY_LIMIT = 500;

// ------------------------------------------------------------------ run document

/** Storage shape: JSON only. */
export type RunDocValue = {
  taskId: string;
  record: JsonValue;
};

/** Typed shape handed to callers. */
export interface RunDoc {
  readonly taskId: string;
  readonly record: RunRecord;
}

/**
 * Session-scoped family keyed by `runId`. `checkpointWhen` is always true: a mirror is a complete
 * base, never a delta, so a reopened document needs no replay history.
 */
export const RunDocFamily = defineDocFamily<RunDocValue, RunDocValue>({
  kind: ARGOS_RUN_DOC_KIND,
  version: 1,
  family: true,
  scope: "session",
  initial: (seed) => ({ taskId: seed.taskId, record: seed.record }),
  checkpointWhen: () => true,
});

/** Cast a stored mirror to its typed shape. */
export function toRunDoc(value: Readonly<RunDocValue>): RunDoc {
  return { taskId: value.taskId, record: value.record as unknown as RunRecord };
}

// ------------------------------------------------------------------ gate document

/**
 * Storage shape of one gate decision document. Optional values are `null` rather than absent so
 * the document satisfies Chord's `JsonValue` and round-trips exactly (same convention as the
 * history document).
 */
export type GateDocValue = {
  runId: string;
  gateId: string;
  stepId: string;
  kind: string;
  question: string;
  choices: JsonValue;
  status: "pending" | "decided";
  decision: string | null;
  decidedBy: string | null;
  decidedVia: string | null;
  comment: string | null;
  decidedAt: number | null;
  createdAt: number;
};

/** Typed shape handed to callers (RPC, tests, the gate task). */
export interface GateDoc {
  readonly runId: string;
  readonly gateId: string;
  readonly stepId: string;
  readonly kind: GateKind;
  readonly question: string;
  readonly choices: Readonly<Record<string, GateChoiceRecord>>;
  readonly status: "pending" | "decided";
  readonly decision?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly comment?: string;
  readonly decidedAt?: number;
  readonly createdAt: number;
}

/** The logical document name (D4): `argos.gate.<runId>.<gateId>`. */
export function gateDocName(runId: string, gateId: string): string {
  return `${ARGOS_GATE_DOC_KIND}.${runId}.${gateId}`;
}

/** The family key for one gate: `${runId}.${gateId}` (neither part can contain a dot). */
export function gateKey(runId: string, gateId: string): string {
  return `${runId}.${gateId}`;
}

/**
 * Session-scoped family keyed by `${runId}.${gateId}`. `checkpointWhen` is always true: the
 * document is a complete value, so a reopened session needs no replay history.
 */
export const GateDocFamily = defineDocFamily<GateDocValue, GateDocValue>({
  kind: ARGOS_GATE_DOC_KIND,
  version: 1,
  family: true,
  scope: "session",
  initial: (seed) => ({
    runId: seed.runId,
    gateId: seed.gateId,
    stepId: seed.stepId,
    kind: seed.kind,
    question: seed.question,
    choices: seed.choices,
    status: seed.status,
    decision: seed.decision,
    decidedBy: seed.decidedBy,
    decidedVia: seed.decidedVia,
    comment: seed.comment,
    decidedAt: seed.decidedAt,
    createdAt: seed.createdAt,
  }),
  checkpointWhen: () => true,
});

/** Cast a stored gate document to its typed shape (drops the `null` placeholders). */
export function toGateDoc(value: Readonly<GateDocValue>): GateDoc {
  return {
    runId: value.runId,
    gateId: value.gateId,
    stepId: value.stepId,
    kind: value.kind as GateKind,
    question: value.question,
    choices: value.choices as unknown as Readonly<Record<string, GateChoiceRecord>>,
    status: value.status,
    ...(value.decision === null ? {} : { decision: value.decision }),
    ...(value.decidedBy === null ? {} : { decidedBy: value.decidedBy }),
    ...(value.decidedVia === null ? {} : { decidedVia: value.decidedVia }),
    ...(value.comment === null ? {} : { comment: value.comment }),
    ...(value.decidedAt === null ? {} : { decidedAt: value.decidedAt }),
    createdAt: value.createdAt,
  };
}

/** The seed of a gate document, built from the run record's `GateRecord`. */
export function gateDocSeed(runId: string, gate: GateRecord): GateDocValue {
  return {
    runId,
    gateId: gate.id,
    stepId: gate.stepId,
    kind: gate.kind,
    question: gate.question,
    choices: gate.choices as unknown as JsonValue,
    status: "pending",
    decision: null,
    decidedBy: null,
    decidedVia: null,
    comment: null,
    decidedAt: null,
    createdAt: gate.createdAt,
  };
}

/**
 * Create (or re-open) the gate document for a freshly opened gate, inside the commit that also
 * creates the gate task and mirrors the run. A document that is already decided is **never**
 * reset: re-creating a gate task after a crash must not undo a decision that already landed.
 */
export async function openGateDoc(tx: Tx, runId: string, gate: GateRecord): Promise<void> {
  const doc = await tx.doc(GateDocFamily, gateKey(runId, gate.id), gateDocSeed(runId, gate));
  if (doc.status === "decided") return;
  doc.runId = runId;
  doc.gateId = gate.id;
  doc.stepId = gate.stepId;
  doc.kind = gate.kind;
  doc.question = gate.question;
  doc.choices = gate.choices as unknown as JsonValue;
  doc.status = "pending";
  doc.decision = null;
  doc.decidedBy = null;
  doc.decidedVia = null;
  doc.comment = null;
  doc.decidedAt = null;
  doc.createdAt = gate.createdAt;
}

/** What a decision write actually did: the winner of the first-writer-wins race. */
export interface GateDecisionWrite {
  readonly written: boolean;
  /** The decision stored in the document (the winner, also on a duplicate). */
  readonly decision: string | null;
  readonly decidedAt: number | null;
}

export interface GateDecisionWriteInput {
  readonly decision: string;
  readonly decidedAt: number;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
}

/**
 * Write the decision once. Must be called inside the host's single `root.commit()` so the read
 * and the write are atomic: the first writer wins and every later writer sees `written: false`
 * with the winning decision.
 */
export async function writeGateDecision(
  tx: Tx,
  runId: string,
  gate: GateRecord,
  input: GateDecisionWriteInput,
): Promise<GateDecisionWrite> {
  const doc = await tx.doc(GateDocFamily, gateKey(runId, gate.id), gateDocSeed(runId, gate));
  if (doc.status === "decided") {
    return { written: false, decision: doc.decision, decidedAt: doc.decidedAt };
  }
  doc.status = "decided";
  doc.decision = input.decision;
  doc.decidedBy = input.decidedBy ?? null;
  doc.decidedVia = input.decidedVia ?? null;
  doc.comment = input.comment ?? null;
  doc.decidedAt = input.decidedAt;
  return { written: true, decision: doc.decision, decidedAt: doc.decidedAt };
}

/**
 * Bookkeeping for after-tasks (FR11): adopt a more advanced `after[id]` state from the mirror.
 *
 * The reducer owns every main-graph decision and refuses to touch a terminal run; after-task
 * status is host-owned read-model data that never changes `run.status`. A manual
 * `startAfterTask` may patch the mirror while the run task is still committing its own terminal
 * state, so the run task reads the mirror inside its commit and keeps whichever `after` entry is
 * further along (rank `pending < running < completed/failed/skipped`).
 */
export const AFTER_STATUS_RANK: Readonly<Record<string, number>> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  skipped: 2,
};

export function mergeAfterStatuses<T extends RunRecord["after"]>(
  current: T,
  stored: RunRecord["after"],
): T {
  let changed = false;
  const merged: Record<string, RunRecord["after"][string]> = { ...current };
  for (const [id, entry] of Object.entries(stored)) {
    const mine = merged[id];
    if (mine === undefined) continue;
    const rankMine = AFTER_STATUS_RANK[mine.status] ?? 0;
    const rankStored = AFTER_STATUS_RANK[entry.status] ?? 0;
    const takeStored =
      rankStored > rankMine ||
      (rankStored === rankMine && mine.endedAt === undefined && entry.endedAt !== undefined);
    if (!takeStored) continue;
    merged[id] = entry;
    changed = true;
  }
  return (changed ? merged : current) as T;
}

/**
 * Read the run mirror and merge its `after` statuses into `record`, inside the caller's commit.
 * Returns `record` unchanged when nothing advanced (so a commit that only parks the task does not
 * churn the document).
 */
export async function mergeAfterFromMirror(tx: Tx, taskId: TaskId, record: RunRecord): Promise<RunRecord> {
  const doc = await tx.doc(RunDocFamily, record.id, mirrorSeed(taskId, record));
  const stored = doc.record as unknown as RunRecord;
  const after = mergeAfterStatuses(record.after, stored.after);
  if (after === record.after) return record;
  return {
    ...record,
    after,
    updatedAt: Math.max(record.updatedAt, stored.updatedAt),
    seq: record.seq + 1,
  };
}

/** Patch one `after[id]` state in the parent run mirror (an after-task's own terminal commit). */
export async function writeAfterStatus(
  tx: Tx,
  parent: Readonly<RunDocValue>,
  afterId: string,
  patch: { readonly status: RunRecord["after"][string]["status"]; readonly endedAt?: number },
): Promise<void> {
  const parentRecord = parent.record as unknown as RunRecord;
  // `tx.doc()` returns the *current* value; the phase's snapshot is only a creation seed.
  const doc = await tx.doc(RunDocFamily, parentRecord.id, {
    taskId: parent.taskId,
    record: parent.record,
  });
  const record = doc.record as unknown as RunRecord;
  const current = record.after[afterId];
  if (current === undefined) return;
  if ((AFTER_STATUS_RANK[patch.status] ?? 0) < (AFTER_STATUS_RANK[current.status] ?? 0)) return;
  const next: RunRecord["after"][string] = {
    ...current,
    status: patch.status,
    ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
  };
  doc.record = {
    ...record,
    after: { ...record.after, [afterId]: next },
    updatedAt: Math.max(record.updatedAt, patch.endedAt ?? record.updatedAt),
    seq: record.seq + 1,
  } as unknown as JsonValue;
}

// ------------------------------------------------------------------ history document

export const HISTORY_EVENT_TYPES = [
  "run_started",
  "select",
  "dispatch",
  "settle",
  "gate",
  "gate_decided",
  "finish",
  "effect_skipped",
  "task_error",
  "after_queued",
  "after_start",
] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

/**
 * One history line. Optional fields are `null` rather than absent so the value satisfies Chord's
 * `JsonValue` (which has no `undefined`) and a stored document round-trips exactly.
 */
export type HistoryEvent = {
  at: number;
  seq: number;
  type: HistoryEventType;
  stepId: string | null;
  attempt: number | null;
  detail: string | null;
};

export type HistoryDocValue = { events: HistoryEvent[] };

export const HistoryDocFamily = defineDocFamily<HistoryDocValue, HistoryDocValue>({
  kind: ARGOS_HISTORY_DOC_KIND,
  version: 1,
  family: true,
  scope: "session",
  initial: () => ({ events: [] }),
  checkpointWhen: () => true,
});

/** Fields a caller supplies; `at`, `seq`, and `type` are filled by the writer. */
export interface NewHistoryEvent {
  readonly type: HistoryEventType;
  readonly stepId?: string | undefined;
  readonly attempt?: number | undefined;
  readonly detail?: string | undefined;
}

// ------------------------------------------------------------------ writers

function mirrorSeed(taskId: TaskId, record: RunRecord): RunDocValue {
  return { taskId: String(taskId), record: record as unknown as JsonValue };
}

/** Write the run mirror. Safe on both creation and update. */
export async function writeRunMirror(
  tx: Tx,
  taskId: TaskId,
  record: RunRecord,
): Promise<void> {
  const doc = await tx.doc(RunDocFamily, record.id, mirrorSeed(taskId, record));
  doc.taskId = String(taskId);
  doc.record = record as unknown as JsonValue;
}

/** Append one event and drop the oldest past {@link HISTORY_LIMIT}. Exported for the cap test. */
export function pushHistoryEvent(events: HistoryEvent[], event: HistoryEvent): void {
  events.push(event);
  const overflow = events.length - HISTORY_LIMIT;
  if (overflow > 0) events.splice(0, overflow);
}

/** Append one bounded history event. Drops the oldest events past {@link HISTORY_LIMIT}. */
export async function appendRunHistory(
  tx: Tx,
  runId: string,
  record: RunRecord,
  event: NewHistoryEvent,
): Promise<void> {
  const doc = await tx.doc(HistoryDocFamily, runId, { events: [] });
  pushHistoryEvent(doc.events, {
    at: record.updatedAt,
    seq: record.seq,
    type: event.type,
    stepId: event.stepId ?? null,
    attempt: event.attempt ?? null,
    detail: event.detail ?? null,
  });
}

/**
 * Write the mirror and (optionally) one history event. Always called from inside the same
 * `runtime.commit()` that returns the next checkpoint.
 */
export async function writeRunState(
  tx: Tx,
  taskId: TaskId,
  record: RunRecord,
  event?: NewHistoryEvent,
): Promise<void> {
  await writeRunMirror(tx, taskId, record);
  if (event !== undefined) await appendRunHistory(tx, record.id, record, event);
}

/** Detail string for an effect the Phase 4 host deliberately does not execute yet. */
export function skippedEffectDetail(type: string, note: string): string {
  return `${type}: ${note}`;
}
