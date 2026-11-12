/**
 * The schedule documents (FR1.1, FR1.4, FR4.3): `argos.schedule.<id>` documents plus the
 * `argos.schedules` singleton that indexes their ids.
 *
 * The shape follows `mirror.ts`: a session-scoped family with `checkpointWhen: () => true` (a
 * schedule document is a complete value, never a delta, so a reopened session needs no replay
 * history), a typed shape for callers, and a storage value whose optional fields are `null`
 * instead of absent so the document is strict JSON and round-trips byte-for-byte.
 *
 * Two rules keep the registry trustworthy:
 *
 * 1. **The index is the roster.** A document is only ever seeded (read with `tx.doc`) for an id the
 *    index contains, so a read can never re-create a schedule someone just deleted (FR7.5).
 * 2. **Every read is validated.** `hydrateScheduleDoc` refuses unknown keys and wrong types, so a
 *    hand-edited SQLite row cannot make the runner fire something the schema does not describe.
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";

import { ArgosError } from "../errors.js";
import type { Scalar } from "../playbook/ir.js";
import {
  CatchUpSchema,
  FIRE_LOG_LIMIT,
  FireEntrySchema,
  FireReasonSchema,
  FireStatusSchema,
  KEEP_DEFAULT,
  KeepSchema,
  MISSED_COUNT_OVERFLOW,
  OverlapSchema,
  RUN_IDS_LIMIT,
  SCHEDULE_ID_PATTERN,
  ScalarValueSchema,
} from "../schedule/model.js";
import { ulidFrom } from "./ulid.js";

/** The document kinds (FR1.1). */
export const ARGOS_SCHEDULE_DOC_KIND = "argos.schedule";
export const ARGOS_SCHEDULES_INDEX_DOC_KIND = "argos.schedules";

/** `"none"` and `"worktree"` only: the schedule stores the mode, never a base ref (FR23/D9). */
export const ScheduleIsolationSchema = z.enum(["none", "worktree"]);
export type ScheduleIsolation = z.infer<typeof ScheduleIsolationSchema>;

// ------------------------------------------------------------------ typed shapes

/** One fire outcome (FR1.4). Applicable fields only; the stored value uses `null` placeholders. */
export interface FireEntry {
  readonly fireAt: number;
  readonly at: number;
  readonly reason: "cron" | "catch_up" | "run_now";
  readonly status: "started" | "skipped_overlap" | "refused" | "missed";
  readonly runId?: string;
  readonly errorCode?: string | null;
  readonly message?: string;
  readonly count?: number | "10000+";
  readonly from?: number;
  readonly to?: number;
}

/** One schedule, exactly as FR1.4 lists it. */
export interface ScheduleDoc {
  readonly id: string;
  /** FR1.3: a fresh ULID per creation, so a re-created id is a different schedule. */
  readonly uid: string;
  readonly playbookId: string;
  readonly cwd: string;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly isolation?: "none" | "worktree";
  readonly cron: string;
  readonly tz: string;
  readonly overlap: "skip" | "allow";
  readonly catchUp: "all" | number;
  readonly keep: "all" | number;
  readonly enabled: boolean;
  /** FR7.3/FR7.4: incremented by every write, so a fire in progress aborts in its commit. */
  readonly generation: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** `null` only while the schedule is disabled (FR7.3). */
  readonly nextFireAt: number | null;
  readonly lastFire?: FireEntry;
  readonly liveRunId?: string;
  /** Newest first, capped at {@link RUN_IDS_LIMIT} (FR9.2). */
  readonly runIds: readonly string[];
  /** Newest first, capped at {@link FIRE_LOG_LIMIT}. */
  readonly fires: readonly FireEntry[];
  /** FR6.1/FR10.3: `0` after a successful fire, `+1` for each refused one. */
  readonly consecutiveFailures: number;
}

// ------------------------------------------------------------------ typed schemas

/**
 * The strict typed schema. `writeScheduleDoc` validates every document against it, so a refactor
 * that drops a field fails in the write path instead of silently losing data.
 *
 * String fields have no minimum length on purpose: the empty seed a first read uses must parse, and
 * the values that matter (`id`, `cron`, `tz`, `uid`) are already refused by the loader, the cron
 * parser, or the fire guards.
 */
export const ScheduleDocSchema = z.strictObject({
  id: z.string().regex(SCHEDULE_ID_PATTERN),
  uid: z.string(),
  playbookId: z.string(),
  cwd: z.string(),
  inputs: z.record(z.string(), ScalarValueSchema),
  isolation: ScheduleIsolationSchema.optional(),
  cron: z.string(),
  tz: z.string(),
  overlap: OverlapSchema,
  catchUp: CatchUpSchema,
  keep: KeepSchema,
  enabled: z.boolean(),
  generation: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextFireAt: z.number().nullable(),
  lastFire: FireEntrySchema.optional(),
  liveRunId: z.string().optional(),
  runIds: z.array(z.string()),
  fires: z.array(FireEntrySchema),
  consecutiveFailures: z.number().int().min(0),
});

// ------------------------------------------------------------------ storage shapes

/**
 * Storage shape of one fire entry: every optional field is `null` so the value satisfies Chord's
 * `JsonValue` (same convention as `GateDocValue` and `HistoryEvent`).
 */
export type FireEntryValue = {
  fireAt: number;
  at: number;
  reason: string;
  status: string;
  runId: string | null;
  errorCode: string | null;
  message: string | null;
  count: number | string | null;
  from: number | null;
  to: number | null;
};

/** Storage shape of one schedule document. */
export type ScheduleDocValue = {
  id: string;
  uid: string;
  playbookId: string;
  cwd: string;
  inputs: Record<string, JsonValue>;
  isolation: string | null;
  cron: string;
  tz: string;
  overlap: string;
  catchUp: string | number;
  keep: string | number;
  enabled: boolean;
  generation: number;
  createdAt: number;
  updatedAt: number;
  nextFireAt: number | null;
  lastFire: FireEntryValue | null;
  liveRunId: string | null;
  runIds: string[];
  fires: FireEntryValue[];
  consecutiveFailures: number;
};

/**
 * The strict storage schema: the same fields with `null` placeholders. `hydrateScheduleDoc` runs
 * this over the raw value **before** converting, which is what refuses an unknown key a hand edit
 * could add — the typed converter would silently drop it.
 */
const FireEntryValueSchema = z.strictObject({
  fireAt: z.number(),
  at: z.number(),
  reason: FireReasonSchema,
  status: FireStatusSchema,
  runId: z.string().nullable(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  count: z.union([z.number().int(), z.literal(MISSED_COUNT_OVERFLOW)]).nullable(),
  from: z.number().nullable(),
  to: z.number().nullable(),
});

const ScheduleDocValueSchema = z.strictObject({
  id: z.string().regex(SCHEDULE_ID_PATTERN),
  uid: z.string(),
  playbookId: z.string(),
  cwd: z.string(),
  inputs: z.record(z.string(), ScalarValueSchema),
  isolation: ScheduleIsolationSchema.nullable(),
  cron: z.string(),
  tz: z.string(),
  overlap: OverlapSchema,
  catchUp: CatchUpSchema,
  keep: KeepSchema,
  enabled: z.boolean(),
  generation: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextFireAt: z.number().nullable(),
  lastFire: FireEntryValueSchema.nullable(),
  liveRunId: z.string().nullable(),
  runIds: z.array(z.string()),
  fires: z.array(FireEntryValueSchema),
  consecutiveFailures: z.number().int().min(0),
});

// ------------------------------------------------------------------ documents

/**
 * Session-scoped family keyed by schedule id. `checkpointWhen` is always true: the document is a
 * complete value, so reopening a session needs no replay history.
 */
export const ScheduleDocFamily = defineDocFamily<ScheduleDocValue, ScheduleDocValue>({
  kind: ARGOS_SCHEDULE_DOC_KIND,
  version: 1,
  family: true,
  scope: "session",
  initial: (seed) => ({
    id: seed.id,
    uid: seed.uid,
    playbookId: seed.playbookId,
    cwd: seed.cwd,
    inputs: seed.inputs,
    isolation: seed.isolation,
    cron: seed.cron,
    tz: seed.tz,
    overlap: seed.overlap,
    catchUp: seed.catchUp,
    keep: seed.keep,
    enabled: seed.enabled,
    generation: seed.generation,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    nextFireAt: seed.nextFireAt,
    lastFire: seed.lastFire,
    liveRunId: seed.liveRunId,
    runIds: seed.runIds,
    fires: seed.fires,
    consecutiveFailures: seed.consecutiveFailures,
  }),
  checkpointWhen: () => true,
});

/**
 * The session index of schedule ids (FR1.1). It is the roster every read and every commit consults:
 * an id missing here means `schedule_unknown`, and no document is ever seeded for it, so a deleted
 * schedule cannot be resurrected by a stale read.
 */
export type SchedulesIndexDocValue = { ids: JsonValue[] };

export const SchedulesIndexDoc = defineDoc<SchedulesIndexDocValue>({
  kind: ARGOS_SCHEDULES_INDEX_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => true,
});

/** The empty document used only as a `tx.doc` creation seed; it is never written as a schedule. */
export function scheduleDocSeed(id: string): ScheduleDocValue {
  return {
    id,
    uid: "",
    playbookId: "",
    cwd: "",
    inputs: {},
    isolation: null,
    cron: "",
    tz: "",
    overlap: "skip",
    catchUp: "all",
    keep: KEEP_DEFAULT,
    enabled: false,
    generation: 0,
    createdAt: 0,
    updatedAt: 0,
    nextFireAt: null,
    lastFire: null,
    liveRunId: null,
    runIds: [],
    fires: [],
    consecutiveFailures: 0,
  };
}

// ------------------------------------------------------------------ converters

/** Storage value → typed shape (drops the `null` placeholders). */
export function toScheduleDoc(value: Readonly<ScheduleDocValue>): ScheduleDoc {
  const isolation = value.isolation;
  const lastFire = value.lastFire;
  const liveRunId = value.liveRunId;
  return {
    id: value.id,
    uid: value.uid,
    playbookId: value.playbookId,
    cwd: value.cwd,
    // Copies, so a caller can never mutate the snapshot its document came from.
    inputs: { ...value.inputs } as Readonly<Record<string, Scalar>>,
    ...(isolation === null ? {} : { isolation: isolation as "none" | "worktree" }),
    cron: value.cron,
    tz: value.tz,
    overlap: value.overlap as "skip" | "allow",
    catchUp: value.catchUp as "all" | number,
    keep: value.keep as "all" | number,
    enabled: value.enabled,
    generation: value.generation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextFireAt: value.nextFireAt,
    ...(lastFire === null ? {} : { lastFire: toFireEntry(lastFire) }),
    ...(liveRunId === null ? {} : { liveRunId }),
    runIds: [...value.runIds],
    fires: value.fires.map(toFireEntry),
    consecutiveFailures: value.consecutiveFailures,
  };
}

/** Typed shape → storage value (fills every optional field with `null`). */
export function toScheduleDocValue(doc: Readonly<ScheduleDoc>): ScheduleDocValue {
  const inputs: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(doc.inputs)) inputs[name] = value;
  return {
    id: doc.id,
    uid: doc.uid,
    playbookId: doc.playbookId,
    cwd: doc.cwd,
    inputs,
    isolation: doc.isolation ?? null,
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
    lastFire: doc.lastFire === undefined ? null : toFireEntryValue(doc.lastFire),
    liveRunId: doc.liveRunId ?? null,
    runIds: [...doc.runIds],
    fires: doc.fires.map(toFireEntryValue),
    consecutiveFailures: doc.consecutiveFailures,
  };
}

/** One fire entry: storage → typed. */
export function toFireEntry(value: Readonly<FireEntryValue>): FireEntry {
  const runId = value.runId;
  const errorCode = value.errorCode;
  const message = value.message;
  const count = value.count;
  const from = value.from;
  const to = value.to;
  const { fireAt, at, reason, status } = value;
  return {
    fireAt,
    at,
    reason: reason as FireEntry["reason"],
    status: status as FireEntry["status"],
    ...(runId === null ? {} : { runId }),
    ...(errorCode === null ? {} : { errorCode }),
    ...(message === null ? {} : { message }),
    ...(count === null ? {} : { count: count as number | "10000+" }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
  };
}

/** One fire entry: typed → storage. */
export function toFireEntryValue(entry: Readonly<FireEntry>): FireEntryValue {
  return {
    fireAt: entry.fireAt,
    at: entry.at,
    reason: entry.reason,
    status: entry.status,
    runId: entry.runId ?? null,
    errorCode: entry.errorCode ?? null,
    message: entry.message ?? null,
    count: entry.count ?? null,
    from: entry.from ?? null,
    to: entry.to ?? null,
  };
}

// ------------------------------------------------------------------ hydration

/**
 * Validate a raw stored value and convert it to the typed shape. A value that fails the strict
 * schema (an unknown key, a wrong type, an out-of-range `keep`) is refused instead of silently
 * repaired: the schedule is corrupt, and firing from a guess is worse than failing the read.
 */
export function hydrateScheduleDoc(value: unknown): ScheduleDoc {
  const parsed = ScheduleDocValueSchema.safeParse(value);
  if (!parsed.success) {
    const where = typeof value === "object" && value !== null && "id" in value
      ? ` for schedule ${JSON.stringify((value as { id?: unknown }).id)}`
      : "";
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ArgosError(
      "invalid_request",
      `stored schedule document${where} does not match the schedule schema (${issues})`,
    );
  }
  return toScheduleDoc(parsed.data);
}

// ------------------------------------------------------------------ access helpers

/** The ids in the schedule index, strings only (a hand-edited row may hold anything). */
export function scheduleIds(index: Readonly<SchedulesIndexDocValue>): string[] {
  return index.ids.filter((id): id is string => typeof id === "string");
}

/** Add `id` to the index exactly once. Call inside the commit that writes the document. */
export async function registerSchedule(tx: Tx, id: string): Promise<void> {
  const index = await tx.doc(SchedulesIndexDoc);
  if (!scheduleIds(index).includes(id)) index.ids.push(id);
}

/** Drop `id` from the index. Call inside the commit that retires the document. */
export async function unregisterSchedule(tx: Tx, id: string): Promise<void> {
  const index = await tx.doc(SchedulesIndexDoc);
  const at = index.ids.indexOf(id);
  if (at >= 0) index.ids.splice(at, 1);
}

/**
 * Read one schedule inside a commit, or `undefined` when the index does not list it.
 *
 * The index check comes **first** and is the whole point: `tx.doc` seeds a document that does not
 * exist, so reading an id the index dropped would re-create the schedule a `remove` (or an aborting
 * fire) just deleted (FR7.5, FR4.5). `seed` lets a caller supply its own creation value; the default
 * is the empty document, which the fire guards then treat as "changed".
 */
export async function readScheduleDoc(
  tx: Tx,
  id: string,
  seed: ScheduleDocValue = scheduleDocSeed(id),
): Promise<ScheduleDoc | undefined> {
  const index = await tx.doc(SchedulesIndexDoc);
  if (!scheduleIds(index).includes(id)) return undefined;
  const draft = await tx.doc(ScheduleDocFamily, id, seed);
  return hydrateScheduleDoc(plainValue(draft));
}

/**
 * Write one schedule document inside the caller's commit. The typed document is validated first, so
 * an in-process bug cannot store a shape the reader would refuse.
 */
export async function writeScheduleDoc(tx: Tx, doc: ScheduleDoc): Promise<void> {
  const parsed = ScheduleDocSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 20)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ArgosError(
      "invalid_request",
      `schedule ${JSON.stringify(doc.id)} cannot be stored (${issues})`,
    );
  }
  const value = toScheduleDocValue(doc);
  const draft = await tx.doc(ScheduleDocFamily, doc.id, value);
  draft.id = value.id;
  draft.uid = value.uid;
  draft.playbookId = value.playbookId;
  draft.cwd = value.cwd;
  draft.inputs = value.inputs;
  draft.isolation = value.isolation;
  draft.cron = value.cron;
  draft.tz = value.tz;
  draft.overlap = value.overlap;
  draft.catchUp = value.catchUp;
  draft.keep = value.keep;
  draft.enabled = value.enabled;
  draft.generation = value.generation;
  draft.createdAt = value.createdAt;
  draft.updatedAt = value.updatedAt;
  draft.nextFireAt = value.nextFireAt;
  draft.lastFire = value.lastFire;
  draft.liveRunId = value.liveRunId;
  draft.runIds = value.runIds;
  draft.fires = value.fires;
  draft.consecutiveFailures = value.consecutiveFailures;
}

/** Detach a Chord draft from its tracking proxy so zod sees a plain JSON value. */
function plainValue(draft: object): unknown {
  return JSON.parse(JSON.stringify(draft)) as unknown;
}

// ------------------------------------------------------------------ ids and bounds

/**
 * FR4.3: the run id of one fired schedule time — deterministic, so a crash before the commit makes
 * the next tick reuse the same run (and the same `<home>/worktrees/<runId>`) instead of starting a
 * second one. The random part comes from `sha256(uid:fireAt)`, so two schedules due at the same
 * instant never collide.
 */
export function scheduleRunId(uid: string, fireAt: number): string {
  const digest = createHash("sha256").update(`${uid}:${fireAt}`).digest();
  return ulidFrom(fireAt, digest);
}

/** Prepend one fire entry and keep the newest {@link FIRE_LOG_LIMIT} (NFR: bounded document). */
export function pushFire(fires: FireEntry[], entry: FireEntry): void {
  fires.unshift(entry);
  const overflow = fires.length - FIRE_LOG_LIMIT;
  if (overflow > 0) fires.splice(fires.length - overflow, overflow);
}

/** Prepend one run id, keep it unique, and cap the list at {@link RUN_IDS_LIMIT} (FR9.2). */
export function pushRunId(runIds: string[], runId: string): void {
  const existing = runIds.indexOf(runId);
  if (existing >= 0) runIds.splice(existing, 1);
  runIds.unshift(runId);
  const overflow = runIds.length - RUN_IDS_LIMIT;
  if (overflow > 0) runIds.splice(runIds.length - overflow, overflow);
}

/**
 * FR6.2: a stored fire message is cut to 500 characters. Callers pass either an `ArgosError`
 * message or a bare error name, never an input or environment value.
 */
export function boundMessage(message: string): string {
  return message.slice(0, 500);
}
