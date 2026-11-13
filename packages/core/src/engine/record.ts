/**
 * The durable run checkpoint (`RunRecord`) — the complete, frozen state of one run, and the
 * only input/output of the pure engine (`reducer.ts`). Everything is plain JSON so the record
 * survives a SQLite checkpoint round-trip byte-for-byte (Phase 4 asserts this).
 *
 * Two invariants are load-bearing for the rest of the engine:
 *
 * 1. **No zod defaults.** `hydrateRunRecord` validates with strict schemas but returns the
 *    *input* object (deep-frozen), not zod's rebuild, so the key order written by the
 *    constructor is preserved. A strict schema rejects unknown keys instead of stripping them.
 * 2. **Optional means absent.** Optional properties are only present when they have a value;
 *    constructors and the reducer delete them rather than storing `undefined`.
 */

import { z } from "zod";

import { ARGOS_ERROR_CODES } from "../errors.js";
import type { GateIR, PlaybookIR, Scalar, StepIR, StepKind } from "../playbook/ir.js";
import { deepFreeze } from "../playbook/ir.js";

// ------------------------------------------------------------------ status

/**
 * Run status.
 *
 * - `pending`   — created, no tick has run yet.
 * - `running`   — the engine is active (running / dispatchable steps exist).
 * - `waiting`   — parked on a gate with nothing else running (distinguishes a human wait
 *                 from a crashed/stuck run in the UI and in `argos doctor`).
 * - `completed` — every main step is `completed`/`skipped`, or an `end` transition fired.
 * - `failed`    — a step failed (or the run deadline / loop-limit rejection fired).
 * - `cancelled` — an operator cancelled the run.
 */
export const RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Step status. `ready` = eligible but held back by `concurrency`; `waiting` = parked on a gate. */
export const STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

// ------------------------------------------------------------------ records

/** `provider/model` for an agent launch, or a free-form label for another executor. */
export type AttemptOutcome = "completed" | "failed" | "timeout" | "cancelled";

/** One launch attempt. `n` is 1-based; attempts are never dropped from the record. */
export interface AttemptRecord {
  readonly n: number;
  readonly agentId?: string;
  readonly target?: string;
  readonly requestId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outcome?: AttemptOutcome;
  readonly errorCode?: (typeof ARGOS_ERROR_CODES)[number];
  /** Provider/token accounting, free-form numbers (never prompts or transcripts). */
  readonly usage?: Readonly<Record<string, number>>;
}

export interface StepRecord {
  readonly status: StepStatus;
  /** Declared outputs collected so far. Keys are only ever added/overwritten, never removed. */
  readonly outputs: Readonly<Record<string, Scalar>>;
  /** Number of times this step was re-queued by a `goto` (its own loop count). */
  readonly loop: number;
  /** Feedback from the `goto`/gate that re-queued this step (`{{ feedback }}` in the prompt). */
  readonly feedback?: string;
  /** Outcome reported by the latest settled attempt (drives `steps.<id>.outcome` conditions). */
  readonly outcome?: string;
  readonly errorCode?: (typeof ARGOS_ERROR_CODES)[number];
  /** Earliest time a pending retry may be dispatched (set by the timeout handler). */
  readonly notBefore?: number;
  readonly attempts: readonly AttemptRecord[];
}

export type GateKind = "step" | "loop_limit" | "ask";
export type GateComment = "none" | "optional" | "required";
export type GateColor = "primary" | "neutral" | "success" | "warning" | "danger";

/**
 * A gate choice as stored on the run record. A superset of the playbook `GateChoiceIR`:
 * `ask` choices carry their own routing (`goto`/`outcome`/`maxLoops`/`outputs`) so a decision
 * can be applied from the checkpoint alone, without re-reading the (frozen) IR.
 */
export interface GateChoiceRecord {
  readonly label: string;
  readonly comment: GateComment;
  readonly color?: GateColor;
  readonly goto?: string;
  readonly maxLoops?: number;
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

export interface GateStatusRecord {
  readonly status: "pending" | "decided";
  readonly createdAt: number;
  readonly edge?: string;
  readonly target?: string;
  readonly maxLoops?: number;
  readonly decision?: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt?: number;
}

export interface GateRecord extends GateStatusRecord {
  /**
   * D14 gate id: `<stepId>:<n>`, where `n` is the 1-based count of gates opened for that step
   * (step gates and loop-limit gates share the counter, so ids stay unique per run). `edge` on
   * a loop-limit gate names the goto edge that hit the limit.
   */
  readonly id: string;
  readonly kind: GateKind;
  readonly stepId: string;
  readonly question: string;
  readonly choices: Readonly<Record<string, GateChoiceRecord>>;
}

export interface AfterStateRecord {
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface WorktreeRecord {
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

/**
 * FR3: the pinned location of one script — the absolute path resolution found when the run
 * started, and the sha256 of its bytes at that moment. The script task re-hashes the file before
 * every spawn and fails the step with `script_changed` on a mismatch.
 */
export interface ScriptPinRecord {
  readonly path: string;
  readonly sha256: string;
}

/** A provider/model the run may not use until `at` (FR24 quota exhaustion). */
export interface ExhaustedRecord {
  readonly target: string;
  readonly at: number;
}

// ------------------------------------------------------------------ provenance

/**
 * FR8.1: why a scheduled run exists. `cron` fired on time, `catch_up` fired a fire time that
 * `argos serve` missed (sleep, restart), and `run_now` came from `argos schedule run`.
 */
export const RUN_TRIGGER_REASONS = ["cron", "catch_up", "run_now"] as const;
export type RunTriggerReason = (typeof RUN_TRIGGER_REASONS)[number];

/**
 * FR8.1: the schedule fire a run belongs to. A record without a `trigger` was started by a caller
 * (`POST /runs`, the CLI, a plugin tool) — a manual run. `fireAt` is the fire time the run was
 * created for; a `run_now` fire uses the request time.
 */
export interface RunTrigger {
  readonly kind: "schedule";
  readonly scheduleId: string;
  readonly fireAt: number;
  readonly reason: RunTriggerReason;
}

/**
 * Fork provenance (`argos fork`). A fork is a **new run**, so its document still contains exactly
 * the IR it runs; this edge is how the discontinuity is recorded instead of implied.
 *
 * `fromHash` is the hash of the definition the parent ran, `toHash` this run's `playbookHash`.
 * Same-definition forks (nothing edited, or an edit that resolved identically) record both equal.
 */
export interface ForkedFrom {
  /** The parent run id. It may be retired later (`argos rm`); the reference is not resolved. */
  readonly runId: string;
  /** The step the fork resumed at. Its closure was reset; nothing upstream re-ran. */
  readonly stepId: string;
  readonly fromHash: string;
  readonly toHash: string;
}

export interface RunRecord {
  readonly id: string;
  readonly playbookId: string;
  readonly playbookHash: string;
  /** Frozen, fully resolved IR (FR12). Never re-read from disk during a run. */
  readonly ir: PlaybookIR;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly worktree?: WorktreeRecord;
  /**
   * FR8.1: the schedule fire that created this run. Absent on a manual run, and absent on a
   * record written before provenance existed — hydration of old records is unchanged.
   */
  readonly trigger?: RunTrigger;
  /**
   * Fork provenance: the run this one branched from and the definition hashes on both sides
   * (`fromHash` = the parent's, `toHash` = this run's `playbookHash`). Absent on a run started
   * normally, and absent on a record written before fork existed — hydration of old records is
   * unchanged.
   */
  readonly forkedFrom?: ForkedFrom;
  /**
   * FR3: one pin per script name (`<name> → {path, sha256}`), covering the main steps and every
   * after-step. Absent when the run has no script step, and absent on a record written before
   * pinning existed (FR3.6) — such a record resolves at `prepare` instead.
   */
  readonly scripts?: Readonly<Record<string, ScriptPinRecord>>;
  /** Absolute epoch ms for the global run deadline (FR18). Absent = no deadline. */
  readonly deadline?: number;
  /** Final outcome from an `end` transition, when one names it. */
  readonly outcome?: string;
  readonly errorCode?: (typeof ARGOS_ERROR_CODES)[number];
  readonly steps: Readonly<Record<string, StepRecord>>;
  /** Traversals per goto edge, keyed `<source>-><declaredTarget>` (FR15). */
  readonly loops: Readonly<Record<string, number>>;
  /** Extra traversals granted by an approved loop-limit gate, same keys. */
  readonly loopAllowance: Readonly<Record<string, number>>;
  readonly gates: readonly GateRecord[];
  readonly after: Readonly<Record<string, AfterStateRecord>>;
  readonly exhausted: readonly ExhaustedRecord[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Monotonic state-change counter; one bump per event that changes the record. */
  readonly seq: number;
}

// ------------------------------------------------------------------ schema

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const ErrorCodeSchema = z.enum(ARGOS_ERROR_CODES);
const GateChoiceSchema = z.strictObject({
  label: z.string(),
  comment: z.enum(["none", "optional", "required"]),
  color: z.enum(["primary", "neutral", "success", "warning", "danger"]).optional(),
  goto: z.string().min(1).optional(),
  maxLoops: z.number().int().min(1).optional(),
  outcome: z.string().min(1).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});

const AttemptSchema = z.strictObject({
  n: z.number().int().positive(),
  agentId: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.enum(["completed", "failed", "timeout", "cancelled"]).optional(),
  errorCode: ErrorCodeSchema.optional(),
  usage: z.record(z.string(), z.number()).optional(),
});

const StepRecordSchema = z.strictObject({
  status: z.enum(STEP_STATUSES),
  outputs: z.record(z.string(), ScalarSchema),
  loop: z.number().int().min(0),
  feedback: z.string().optional(),
  outcome: z.string().min(1).optional(),
  errorCode: ErrorCodeSchema.optional(),
  notBefore: z.number().optional(),
  attempts: z.array(AttemptSchema),
});

const GateRecordSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["step", "loop_limit", "ask"]),
  stepId: z.string().min(1),
  question: z.string(),
  choices: z.record(z.string(), GateChoiceSchema),
  status: z.enum(["pending", "decided"]),
  createdAt: z.number(),
  edge: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  maxLoops: z.number().int().min(1).optional(),
  decision: z.string().min(1).optional(),
  comment: z.string().optional(),
  decidedBy: z.string().min(1).optional(),
  decidedVia: z.string().min(1).optional(),
  decidedAt: z.number().optional(),
});

const WorktreeSchema = z.strictObject({
  path: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
});

/** FR8.1: the schedule provenance of a run. Strict: a hand-edited record cannot add a key. */
export const RunTriggerSchema = z.strictObject({
  kind: z.literal("schedule"),
  scheduleId: z.string().min(1),
  fireAt: z.number().int(),
  reason: z.enum(RUN_TRIGGER_REASONS),
});

/** FR3: a pinned script. The digest is lowercase hex, so a hand-edited record cannot lie. */
const ScriptPinSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest"),
});

/** Fork provenance: strict, so a hand-edited record cannot add a key or blank a field. */
export const ForkedFromSchema = z.strictObject({
  runId: z.string().min(1),
  stepId: z.string().min(1),
  fromHash: z.string().min(1),
  toHash: z.string().min(1),
});

/**
 * The IR is validated by the loader (Phase 2) and frozen into the run. The checkpoint only
 * checks the identity fields the engine relies on; the rest is opaque so IR additions do not
 * force a schema change here.
 */
const PlaybookIrSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    hash: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()),
    steps: z.array(z.object({ id: z.string().min(1) }).loose()),
    after: z.array(z.object({ id: z.string().min(1) }).loose()),
  })
  .loose();

export const RunRecordSchema = z.strictObject({
  id: z.string().min(1),
  playbookId: z.string().min(1),
  playbookHash: z.string().min(1),
  ir: PlaybookIrSchema,
  inputs: z.record(z.string(), ScalarSchema),
  status: z.enum(RUN_STATUSES),
  cwd: z.string().min(1),
  worktree: WorktreeSchema.optional(),
  trigger: RunTriggerSchema.optional(),
  forkedFrom: ForkedFromSchema.optional(),
  scripts: z.record(z.string().min(1), ScriptPinSchema).optional(),
  deadline: z.number().optional(),
  outcome: z.string().min(1).optional(),
  errorCode: ErrorCodeSchema.optional(),
  steps: z.record(z.string(), StepRecordSchema),
  loops: z.record(z.string(), z.number().int().min(0)),
  loopAllowance: z.record(z.string(), z.number().int().min(0)),
  gates: z.array(GateRecordSchema),
  after: z.record(z.string(), z.strictObject({
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
  })),
  exhausted: z.array(z.strictObject({ target: z.string().min(1), at: z.number() })),
  createdAt: z.number(),
  updatedAt: z.number(),
  seq: z.number().int().min(0),
});

// ------------------------------------------------------------------ construction

/** Thrown by `hydrateRunRecord` when a stored checkpoint is not a valid `RunRecord`. */
export class InvalidRunRecordError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid run record: ${issues.join("; ")}`);
    this.name = "InvalidRunRecordError";
    this.issues = issues;
  }
}

export interface CreateRunRecordInput {
  readonly id: string;
  readonly ir: PlaybookIR;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly cwd: string;
  /** Event time of creation; also the initial `updatedAt`. */
  readonly now: number;
  readonly worktree?: WorktreeRecord;
  /** FR8.1: the schedule fire this run belongs to. Only the scheduler sets it. */
  readonly trigger?: RunTrigger;
  /** Fork provenance. Only `ArgosHost.forkRun` sets it. */
  readonly forkedFrom?: ForkedFrom;
  /** FR3: script pins resolved by the host before the run task exists. */
  readonly scripts?: Readonly<Record<string, ScriptPinRecord>>;
  readonly deadline?: number;
}

/**
 * Build a fresh checkpoint: every step `pending`, no attempts, no gates, no loop counters.
 * `status` starts at `pending`; the first `tick` selects and dispatches.
 */
export function createRunRecord(input: CreateRunRecordInput): RunRecord {
  const steps: Record<string, StepRecord> = {};
  for (const step of input.ir.steps) {
    steps[step.id] = { status: "pending", outputs: {}, loop: 0, attempts: [] };
  }
  const after: Record<string, AfterStateRecord> = {};
  for (const task of input.ir.after) {
    after[task.id] = { status: "pending" };
  }

  const record: Record<string, unknown> = {
    id: input.id,
    playbookId: input.ir.id,
    playbookHash: input.ir.hash,
    ir: input.ir,
    inputs: { ...input.inputs },
    status: "pending" satisfies RunStatus,
    cwd: input.cwd,
  };
  if (input.worktree !== undefined) record["worktree"] = input.worktree;
  // FR8.1: copied field by field so the record holds no alias into the caller's object. A manual
  // run (no trigger) omits the key entirely, so its JSON stays byte-identical to before.
  if (input.trigger !== undefined) {
    record["trigger"] = {
      kind: input.trigger.kind,
      scheduleId: input.trigger.scheduleId,
      fireAt: input.trigger.fireAt,
      reason: input.trigger.reason,
    };
  }
  // FR3: copying the entries keeps the record free of aliases into the caller's object.
  if (input.scripts !== undefined) {
    const scripts: Record<string, ScriptPinRecord> = {};
    for (const [name, pin] of Object.entries(input.scripts)) {
      scripts[name] = { path: pin.path, sha256: pin.sha256 };
    }
    record["scripts"] = scripts;
  }
  if (input.deadline !== undefined) record["deadline"] = input.deadline;
  // Fork provenance: field by field, so the record holds no alias into the caller's object and a
  // normal run's JSON stays byte-identical (the key is simply absent).
  if (input.forkedFrom !== undefined) {
    record["forkedFrom"] = {
      runId: input.forkedFrom.runId,
      stepId: input.forkedFrom.stepId,
      fromHash: input.forkedFrom.fromHash,
      toHash: input.forkedFrom.toHash,
    };
  }
  Object.assign(record, {
    steps,
    loops: {},
    loopAllowance: {},
    gates: [],
    after,
    exhausted: [],
    createdAt: input.now,
    updatedAt: input.now,
    seq: 0,
  });

  const result = RunRecordSchema.safeParse(record);
  if (!result.success) {
    throw new InvalidRunRecordError(formatIssues(result.error));
  }
  return deepFreeze(record as unknown as RunRecord);
}

/**
 * Validate a stored checkpoint and return it unchanged (deep-frozen), preserving key order so
 * `JSON.stringify(hydrateRunRecord(json)) === json` for any record this module produced.
 * Unknown keys are rejected, never stripped.
 */
export function hydrateRunRecord(json: string | unknown): RunRecord {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json) as unknown;
    } catch (cause) {
      throw new InvalidRunRecordError([`not valid JSON: ${(cause as Error).message}`]);
    }
  }
  const result = RunRecordSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidRunRecordError(formatIssues(result.error));
  }
  const issues = invariantIssues(value as RunRecord);
  if (issues.length > 0) throw new InvalidRunRecordError(issues);
  return deepFreeze(value as RunRecord);
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}

/** Cross-field checks zod cannot express; used by hydration (and therefore by Phase 4). */
export function invariantIssues(record: RunRecord): string[] {
  const issues: string[] = [];
  const irStepIds = new Map<string, StepKind>();
  for (const step of record.ir.steps) irStepIds.set(step.id, step.kind);

  for (const id of Object.keys(record.steps)) {
    if (!irStepIds.has(id)) issues.push(`steps.${id}: not a step of the frozen IR`);
  }
  for (const id of irStepIds.keys()) {
    if (record.steps[id] === undefined) issues.push(`steps.${id}: missing from the checkpoint`);
  }
  if (record.playbookId !== record.ir.id) {
    issues.push("playbookId: does not match ir.id");
  }
  if (record.playbookHash !== record.ir.hash) {
    issues.push("playbookHash: does not match ir.hash");
  }

  const gateIds = new Set<string>();
  for (const gate of record.gates) {
    if (gateIds.has(gate.id)) issues.push(`gates.${gate.id}: duplicate gate id`);
    gateIds.add(gate.id);
    if (!irStepIds.has(gate.stepId)) issues.push(`gates.${gate.id}: unknown stepId "${gate.stepId}"`);
  }

  for (const [stepId, step] of Object.entries(record.steps)) {
    const seen = new Set<number>();
    for (const attempt of step.attempts) {
      if (seen.has(attempt.n)) issues.push(`steps.${stepId}.attempts: duplicate attempt n=${attempt.n}`);
      seen.add(attempt.n);
    }
  }

  const afterIds = new Set(record.ir.after.map((task) => task.id));
  for (const id of Object.keys(record.after)) {
    if (!afterIds.has(id)) issues.push(`after.${id}: not an after-task of the frozen IR`);
  }
  for (const id of afterIds) {
    if (record.after[id] === undefined) issues.push(`after.${id}: missing from the checkpoint`);
  }

  return issues;
}

// ------------------------------------------------------------------ draft plumbing

/** Recursively mutable view used while the reducer builds the next state. */
export type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

export type DraftRecord = DeepMutable<RunRecord>;

/** Deep copy through JSON: the record is plain JSON by construction, and key order is kept. */
export function cloneRecord(record: RunRecord): DraftRecord {
  return JSON.parse(JSON.stringify(record)) as DraftRecord;
}

/** Freeze a draft; the reducer's return value. */
export function freezeRecord(draft: DraftRecord): RunRecord {
  return deepFreeze(draft as unknown as RunRecord);
}

// ------------------------------------------------------------------ lookups

/** Step definitions in declaration order (the engine's dispatch order). */
export function stepDefinitions(record: Pick<RunRecord, "ir">): readonly StepIR[] {
  return record.ir.steps;
}

export function stepDefinition(record: Pick<RunRecord, "ir">, stepId: string): StepIR | undefined {
  return record.ir.steps.find((step) => step.id === stepId);
}

export function gateDefinition(step: StepIR): GateIR | undefined {
  return step.gate;
}

/** Count of gates already opened for a step; drives the D14 `<stepId>:<n>` numbering. */
export function gateCount(record: Pick<RunRecord, "gates">, stepId: string): number {
  return record.gates.filter((gate) => gate.stepId === stepId).length;
}

export function nextGateId(record: Pick<RunRecord, "gates">, stepId: string): string {
  return `${stepId}:${gateCount(record, stepId) + 1}`;
}
