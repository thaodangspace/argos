/**
 * The read model the UI and RPC layer consume: `argos.run.<runId>` and
 * `argos.history.<runId>`.
 *
 * Both documents are written **inside the same `runtime.commit()`** that stores the task
 * checkpoint (FR13), so a reader never observes a run state older than the engine's. The mirror
 * is the complete `RunRecord`; the history is an append-only, bounded event log (D16).
 *
 * Document values are typed as JSON-compatible aliases because Chord's `defineDocFamily` requires
 * `JsonObject`. The `record` payload is the same plain JSON the engine and the checkpoint use, so
 * the cast is sound and a snapshot round-trips byte-for-byte.
 */

import type { JsonValue } from "@earendil-works/chord/json";
import { defineDocFamily, type TaskId, type Tx } from "@earendil-works/pi-durable";

import type { RunRecord } from "../engine/index.js";

/** D4 task/document kinds. */
export const ARGOS_RUN_DOC_KIND = "argos.run";
export const ARGOS_HISTORY_DOC_KIND = "argos.history";

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

// ------------------------------------------------------------------ history document

export const HISTORY_EVENT_TYPES = [
  "run_started",
  "select",
  "dispatch",
  "settle",
  "gate",
  "finish",
  "effect_skipped",
  "task_error",
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
