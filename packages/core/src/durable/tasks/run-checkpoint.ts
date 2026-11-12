/**
 * `argos.run` checkpoint shape (FR5.1 split of `tasks/run.ts`).
 *
 * The checkpoint is the whole run: the frozen `RunRecord` plus the bookkeeping that ties it to
 * child tasks. It is a strict contract — `hydrateRunCheckpoint` validates a stored checkpoint and
 * returns the same JSON shape, so a corrupt or stale checkpoint fails loudly instead of being
 * silently repaired.
 *
 * Types only reference the engine and `context.ts`; the zod schema and the invariant checks are
 * the only executable code here, so this module stays free of tasks, I/O, and pi-durable behavior.
 */

import type { TaskId } from "@earendil-works/pi-durable";
import { z } from "zod";

import type { ArgosErrorCode } from "../../errors.js";
import { ARGOS_ERROR_CODES } from "../../errors.js";
import type { Scalar } from "../../playbook/ir.js";
import {
  invariantIssues,
  RunRecordSchema,
  type ExhaustedRecord,
  type RunRecord,
} from "../../engine/index.js";
import { deepFreeze } from "../../playbook/ir.js";

import type { AfterTaskLink } from "../context.js";

// ------------------------------------------------------------------ shape

export type RunPhase = "select" | "await" | "settle" | "gate" | "done";

/** Defensive poll when the engine has no runnable step, no child, and no wake time. */
export const IDLE_POLL_MS = 1_000;

export interface RunTaskInput {
  readonly runId: string;
  /** The freshly created checkpoint; `initial()` copies it into the task checkpoint. */
  readonly record: RunRecord;
  /** D15: the client request that created this run, kept in the checkpoint for auditing. */
  readonly clientRequestId?: string;
  /** Set on an after-task child: the run that started it (FR11). */
  readonly after?: AfterTaskLink;
}

/** One child settlement, mapped from a terminal `argos.step` outcome. */
export interface StepSettlement {
  readonly taskId: TaskId;
  readonly stepId: string;
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, Scalar>>;
  readonly errorCode?: ArgosErrorCode;
  readonly agentId?: string;
  readonly target?: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly feedback?: string;
  /** Quota-exhausted targets observed by the attempt (FR24). */
  readonly exhausted?: readonly ExhaustedRecord[];
}

/** One gate settlement, mapped from a terminal `argos.gate` outcome (FR19). */
export interface GateSettlement {
  readonly taskId: TaskId;
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt: number;
}

export interface RunFinished {
  readonly status: "completed" | "failed" | "cancelled";
  readonly outcome?: string;
  readonly errorCode?: ArgosErrorCode;
}

export interface RunCheckpointFields {
  readonly record: RunRecord;
  /** Latest child task per step id (goto re-runs replace the entry). */
  readonly childTasks: Readonly<Record<string, TaskId>>;
  /** Every step child task id ever created for this run, keyed `String(taskId)` → step id. */
  readonly dispatched: Readonly<Record<string, string>>;
  /** Child task ids of the current wait. Empty outside `await`. */
  readonly awaiting: readonly TaskId[];
  /** Step settlements carried from `await` into `settle`. */
  readonly settles: readonly StepSettlement[];
  /** Latest `argos.gate` child task per gate id (D14 ids, never renumbered). */
  readonly gateTasks: Readonly<Record<string, TaskId>>;
  /** Gate settlements carried from `await` into `settle`. */
  readonly gateSettles: readonly GateSettlement[];
  /** `argos.run` child task per after-task id (FR11). */
  readonly afterTasks: Readonly<Record<string, TaskId>>;
  /** D15: the client request that created this run (`POST /runs` idempotency). */
  readonly lastClientRequestId?: string;
  readonly finished?: RunFinished;
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type RunCheckpoint =
  | (RunCheckpointFields & { readonly phase: "select" })
  | (RunCheckpointFields & { readonly phase: "await" })
  | (RunCheckpointFields & { readonly phase: "settle" })
  | (RunCheckpointFields & { readonly phase: "gate" })
  | (RunCheckpointFields & { readonly phase: "done" });

// ------------------------------------------------------------------ checkpoint schema

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const StepSettlementSchema = z.strictObject({
  taskId: z.number().int().positive(),
  stepId: z.string().min(1),
  outcome: z.string().min(1).optional(),
  outputs: z.record(z.string(), ScalarSchema).optional(),
  errorCode: z.enum(ARGOS_ERROR_CODES).optional(),
  agentId: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  usage: z.record(z.string(), z.number()).optional(),
  feedback: z.string().optional(),
  exhausted: z.array(z.strictObject({ target: z.string().min(1), at: z.number() })).optional(),
});

const GateSettlementSchema = z.strictObject({
  taskId: z.number().int().positive(),
  gateId: z.string().min(1),
  decision: z.string().min(1),
  comment: z.string().optional(),
  decidedBy: z.string().min(1).optional(),
  decidedVia: z.string().min(1).optional(),
  decidedAt: z.number(),
});

const RunFinishedSchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  outcome: z.string().min(1).optional(),
  errorCode: z.enum(ARGOS_ERROR_CODES).optional(),
});

export const RunCheckpointSchema = z.strictObject({
  phase: z.enum(["select", "await", "settle", "gate", "done"]),
  record: RunRecordSchema,
  childTasks: z.record(z.string(), z.number().int().positive()),
  dispatched: z.record(z.string(), z.string().min(1)),
  awaiting: z.array(z.number().int().positive()),
  settles: z.array(StepSettlementSchema),
  gateTasks: z.record(z.string(), z.number().int().positive()),
  gateSettles: z.array(GateSettlementSchema),
  afterTasks: z.record(z.string(), z.number().int().positive()),
  lastClientRequestId: z.string().min(1).optional(),
  finished: RunFinishedSchema.optional(),
});

/** Thrown when a stored `argos.run` checkpoint is not valid. */
export class InvalidRunCheckpointError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid run checkpoint: ${issues.join("; ")}`);
    this.name = "InvalidRunCheckpointError";
    this.issues = issues;
  }
}

/**
 * Validate a stored checkpoint and return the input object unchanged (deep-frozen), so
 * `JSON.stringify(hydrateRunCheckpoint(json)) === json` for any checkpoint this module wrote.
 */
export function hydrateRunCheckpoint(json: string | unknown): RunCheckpoint {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json) as unknown;
    } catch (cause) {
      throw new InvalidRunCheckpointError([`not valid JSON: ${(cause as Error).message}`]);
    }
  }
  const parsed = RunCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidRunCheckpointError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  const checkpoint = value as RunCheckpoint;
  const issues = invariantIssues(checkpoint.record);
  if (issues.length > 0) throw new InvalidRunCheckpointError(issues);
  return deepFreeze(checkpoint);
}
