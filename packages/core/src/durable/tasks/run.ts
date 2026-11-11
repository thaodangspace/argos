/**
 * `argos.run` v1 — the durable run state machine (FR13, FR14, FR15, FR29).
 *
 * Phases: `select → await → settle → gate → done` (static, so the definition never depends on
 * playbook content). The reducer `next()` is the **only** decision maker: this task feeds it
 * `tick` / `stepSettled` / `gateDecided` events and executes the returned effects (create one
 * `argos.step` or `argos.gate` child per effect, mirror the record, open/close the run). It never
 * decides readiness, transitions, loop limits, decisions, or timeouts itself.
 *
 * Atomicity: every state change commits the checkpoint **and** `argos.run.<runId>` **and**
 * `argos.history.<runId>` inside one `runtime.commit()`, so the mirror is never older than the
 * engine (FR13).
 *
 * Phase 5:
 * - `openGate` creates the `argos.gate` child and its decision document in the same commit as
 *   the checkpoint/mirror (D4, FR19). The run then waits on it (`allSettled`) like a step child.
 * - `await` maps a gate child's result to an engine `gateDecided` event, applied in `settle`;
 *   `gate` is the recovery path that re-opens a pending gate whose child broke or was lost (a
 *   restart never renumbers a gate id).
 * - `done` starts every `trigger: auto` after-task as its own `argos.run` child (owned by this
 *   task) and then commits the terminal outcome; `after[id].status` is host-owned bookkeeping and
 *   never changes `run.status` (FR11). A manual after-task is started by
 *   `ArgosHost.startAfterTask`.
 * - A phase error is caught and turns into a cancelled, mirrored run plus a `task_error` history
 *   event and a failed task outcome, so a run is never abandoned without a terminal state.
 */

import { defineTask, type ConversationId, type NextTaskState, type RunningTask, type Task, type TaskId, type TaskOwnership, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { z } from "zod";

import type { ArgosErrorCode } from "../../errors.js";
import { ARGOS_ERROR_CODES } from "../../errors.js";
import type { Scalar } from "../../playbook/ir.js";
import {
  invariantIssues,
  isTerminalRunStatus,
  next,
  RunRecordSchema,
  stepDefinition,
  stepTimeoutMs,
  type Effect,
  type EngineEvent,
  type GateRecord,
  type RunRecord,
} from "../../engine/index.js";
import { deepFreeze } from "../../playbook/ir.js";
import type { AfterTaskLink, GateTaskResult, RunTaskResult, StepTaskResult } from "../context.js";
import {
  appendRunHistory,
  mergeAfterFromMirror,
  openGateDoc,
  skippedEffectDetail,
  writeAfterStatus,
  writeRunState,
  RunDocFamily,
  type NewHistoryEvent,
} from "../mirror.js";
import { planAfterRun, type PlannedAfterRun } from "./after.js";
import type { GateTaskInput, GateTaskDefinition } from "./gate.js";
import type { StepTaskDefinition, StepTaskInput } from "./step.js";

// ------------------------------------------------------------------ shape

export type RunPhase = "select" | "await" | "settle" | "gate" | "done";

/** Defensive poll when the engine has no runnable step, no child, and no wake time. */
export const IDLE_POLL_MS = 1_000;

export interface RunTaskInput {
  readonly runId: string;
  /** The freshly created checkpoint; `initial()` copies it into the task checkpoint. */
  readonly record: RunRecord;
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

// ------------------------------------------------------------------ event mapping

function stepEvents(settlement: StepSettlement, now: number): EngineEvent {
  return {
    type: "stepSettled",
    stepId: settlement.stepId,
    endedAt: now,
    now,
    ...(settlement.outcome === undefined ? {} : { outcome: settlement.outcome }),
    ...(settlement.outputs === undefined ? {} : { outputs: settlement.outputs }),
    ...(settlement.errorCode === undefined ? {} : { errorCode: settlement.errorCode }),
    ...(settlement.agentId === undefined ? {} : { agentId: settlement.agentId }),
    ...(settlement.feedback === undefined ? {} : { feedback: settlement.feedback }),
    ...(settlement.usage === undefined ? {} : { usage: settlement.usage }),
  };
}

function gateEvent(settlement: GateSettlement, now: number): EngineEvent {
  return {
    type: "gateDecided",
    gateId: settlement.gateId,
    decision: settlement.decision,
    decidedAt: settlement.decidedAt,
    now,
    ...(settlement.comment === undefined ? {} : { comment: settlement.comment }),
    ...(settlement.decidedBy === undefined ? {} : { decidedBy: settlement.decidedBy }),
    ...(settlement.decidedVia === undefined ? {} : { decidedVia: settlement.decidedVia }),
  };
}

function settlementFrom(
  checkpoint: RunCheckpoint,
  taskId: TaskId,
  outcome: { status: string; result?: unknown },
): StepSettlement | undefined {
  const stepId = checkpoint.dispatched[String(taskId)];
  if (stepId === undefined) return undefined;
  const base = { taskId, stepId };
  if (outcome.status === "completed") {
    const result = outcome.result as Partial<StepTaskResult> | undefined;
    if (result === undefined) return base;
    return {
      ...base,
      ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
      ...(result.outputs === undefined ? {} : { outputs: result.outputs }),
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(result.agentId === undefined ? {} : { agentId: result.agentId }),
      ...(result.target === undefined ? {} : { target: result.target }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
    };
  }
  // failed / aborted / faulted / orphaned: the child task itself broke, which is a step failure.
  return { ...base, errorCode: "step_failed" };
}

/**
 * Map a completed `argos.gate` child to a gate settlement. A gate task that ended any other way
 * broke (or was aborted): no settlement is produced and the caller drops its checkpoint entry, so
 * the `gate` phase opens a fresh child for the still-pending gate.
 */
function gateSettlementFrom(
  taskId: TaskId,
  gateId: string,
  outcome: { status: string; result?: unknown },
): GateSettlement | undefined {
  if (outcome.status !== "completed") return undefined;
  const result = outcome.result as Partial<GateTaskResult> | undefined;
  if (result === undefined || typeof result.decision !== "string") return undefined;
  return {
    taskId,
    gateId,
    decision: result.decision,
    decidedAt: typeof result.decidedAt === "number" ? result.decidedAt : 0,
    ...(result.comment === undefined ? {} : { comment: result.comment }),
    ...(result.decidedBy === undefined ? {} : { decidedBy: result.decidedBy }),
    ...(result.decidedVia === undefined ? {} : { decidedVia: result.decidedVia }),
  };
}

function historyForEffects(effects: readonly Effect[]): NewHistoryEvent {
  const dispatch = effects.find((effect) => effect.type === "dispatchStep");
  if (dispatch !== undefined && dispatch.type === "dispatchStep") {
    return { type: "dispatch", stepId: dispatch.stepId, attempt: dispatch.attempt };
  }
  const finish = effects.find((effect) => effect.type === "finishRun");
  if (finish !== undefined && finish.type === "finishRun") {
    return {
      type: "finish",
      detail: finish.errorCode ?? finish.outcome ?? finish.status,
    };
  }
  const gate = effects.find((effect) => effect.type === "openGate");
  if (gate !== undefined && gate.type === "openGate") {
    return { type: "gate", stepId: gate.stepId, detail: `${gate.gateId} ${gate.kind}` };
  }
  return { type: "select" };
}

/** Build one `argos.gate` child input from the run record's gate (D14 ids, never renumbered). */
function gateInputFor(record: RunRecord, gate: GateRecord): GateTaskInput {
  return {
    runId: record.id,
    gateId: gate.id,
    stepId: gate.stepId,
    kind: gate.kind,
    ...(gate.edge === undefined ? {} : { edge: gate.edge }),
    ...(gate.target === undefined ? {} : { target: gate.target }),
    question: gate.question,
    choices: gate.choices,
    createdAt: gate.createdAt,
  };
}

interface PlanContext {
  readonly runTaskId: TaskId;
  readonly checkpoint: RunCheckpoint;
  readonly stepTask: StepTaskDefinition;
  readonly gateTask: GateTaskDefinition;
  readonly stepInput: (effect: Extract<Effect, { type: "dispatchStep" }>) => StepTaskInput | undefined;
}

type PlannedState =
  | { readonly status: "running"; readonly checkpoint: RunCheckpoint }
  | { readonly status: "waiting"; readonly checkpoint: RunCheckpoint; readonly on: readonly TaskId[]; readonly policy: "allSettled" }
  | { readonly status: "sleeping"; readonly checkpoint: RunCheckpoint; readonly until: number };

/**
 * Turn the reducer's output into the next task state, creating child tasks and writing the
 * mirror/history in the same transaction. Called only from inside `runtime.commit()`.
 */
async function planNext(
  tx: Tx,
  plan: PlanContext,
  record: RunRecord,
  effects: readonly Effect[],
  now: number,
  liveTaskIds: ReadonlySet<number>,
): Promise<PlannedState> {
  const previous = plan.checkpoint;
  const childTasks: Record<string, TaskId> = { ...previous.childTasks };
  const dispatched: Record<string, string> = { ...previous.dispatched };
  const gateTasks: Record<string, TaskId> = {};
  const afterTasks: Record<string, TaskId> = { ...previous.afterTasks };
  const waiting = new Set<TaskId>();
  let finished: RunFinished | undefined = previous.finished;
  let wakeAt: number | undefined;
  const recorded: NewHistoryEvent[] = [];

  // Reconcile the gate children recorded by earlier phases. A pending gate whose child is gone
  // (or broke) is dropped so the `gate` phase opens a fresh one; a decided gate keeps its task id
  // for auditability. Re-opening never renumbers the gate id (D14).
  for (const [gateId, taskId] of Object.entries(previous.gateTasks)) {
    const gate = record.gates.find((candidate) => candidate.id === gateId);
    if (gate === undefined) continue;
    if (liveTaskIds.has(Number(taskId))) {
      gateTasks[gateId] = taskId;
      waiting.add(taskId);
      continue;
    }
    if (gate.status === "decided") gateTasks[gateId] = taskId;
  }

  for (const effect of effects) {
    switch (effect.type) {
      case "dispatchStep": {
        const input = plan.stepInput(effect);
        if (input === undefined) {
          recorded.push({
            type: "effect_skipped",
            stepId: effect.stepId,
            attempt: effect.attempt,
            detail: skippedEffectDetail("dispatchStep", "step definition missing from the frozen IR"),
          });
          break;
        }
        const childId = await tx.createTask(plan.stepTask, input, {
          ownership: { kind: "task", taskId: plan.runTaskId },
        });
        childTasks[effect.stepId] = childId;
        dispatched[String(childId)] = effect.stepId;
        waiting.add(childId);
        break;
      }
      case "openGate": {
        if (gateTasks[effect.gateId] !== undefined) break; // already open (idempotent)
        const gate = record.gates.find((candidate) => candidate.id === effect.gateId);
        if (gate === undefined) {
          recorded.push({
            type: "effect_skipped",
            stepId: effect.stepId,
            detail: skippedEffectDetail("openGate", `gate ${effect.gateId} missing from the run record`),
          });
          break;
        }
        const childId = await tx.createTask(plan.gateTask, gateInputFor(record, gate), {
          ownership: { kind: "task", taskId: plan.runTaskId },
        });
        await openGateDoc(tx, record.id, gate);
        gateTasks[gate.id] = childId;
        waiting.add(childId);
        break;
      }
      case "finishRun": {
        finished = {
          status: effect.status,
          ...(effect.outcome === undefined ? {} : { outcome: effect.outcome }),
          ...(effect.errorCode === undefined ? {} : { errorCode: effect.errorCode }),
        };
        break;
      }
      case "startAfterTask": {
        // Executed by the `done` phase, which creates one `argos.run` child per auto after-task.
        recorded.push({ type: "after_queued", detail: effect.id });
        break;
      }
      case "decisionRejected": {
        recorded.push({
          type: "effect_skipped",
          detail: skippedEffectDetail("decisionRejected", `${effect.code} on gate ${effect.gateId}`),
        });
        break;
      }
      case "scheduleWake": {
        wakeAt = wakeAt === undefined ? effect.at : Math.min(wakeAt, effect.at);
        break;
      }
    }
  }

  for (const taskId of Object.keys(dispatched)) {
    const id = Number(taskId);
    if (Number.isInteger(id) && liveTaskIds.has(id)) waiting.add(id as TaskId);
  }

  if (finished === undefined && isTerminalRunStatus(record.status)) {
    const status: RunFinished["status"] =
      record.status === "completed" || record.status === "cancelled" ? record.status : "failed";
    finished = {
      status,
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    };
  }

  const base = {
    record,
    childTasks,
    dispatched,
    awaiting: [] as readonly TaskId[],
    settles: [] as readonly StepSettlement[],
    gateTasks,
    gateSettles: [] as readonly GateSettlement[],
    afterTasks,
    ...(finished === undefined ? {} : { finished }),
  };

  await writeRunState(tx, plan.runTaskId, record, historyForEffects(effects));
  for (const event of recorded) {
    // Same commit: the skip/queue record lands with the checkpoint it describes.
    await appendRunHistory(tx, record.id, record, event);
  }

  if (finished !== undefined) {
    return { status: "running", checkpoint: { ...base, phase: "done" } };
  }

  if (waiting.size > 0) {
    const on = [...waiting];
    return {
      status: "waiting",
      on,
      policy: "allSettled",
      checkpoint: { ...base, phase: "await", awaiting: on, settles: [] },
    };
  }

  // A gate is pending with no child task: the `gate` phase opens one (a restart never renumbers).
  if (record.gates.some((gate) => gate.status === "pending" && gateTasks[gate.id] === undefined)) {
    return { status: "running", checkpoint: { ...base, phase: "gate" } };
  }

  // Nothing is live and nothing is gated: poll. This is the retry-backoff path (the engine set
  // `notBefore`) and a safety net for an unexpected empty ready set.
  return {
    status: "sleeping",
    until: wakeAt === undefined ? now + IDLE_POLL_MS : Math.min(wakeAt, now + IDLE_POLL_MS),
    checkpoint: { ...base, phase: "select" },
  };
}

/**
 * Render `{{ feedback }}` into a prompt. Feedback is the only template variable the run task
 * interpolates (the rest is Phase 6): a gate comment or a loop's feedback text must reach the next
 * attempt's prompt (FR15).
 */
export function renderFeedback(prompt: string, feedback: string | undefined): string {
  if (feedback === undefined) return prompt;
  return prompt.replace(/\{\{\s*feedback\s*\}\}/g, feedback);
}

/** Build the child task input from the frozen step definition. */
function stepInputFor(record: RunRecord, effect: Extract<Effect, { type: "dispatchStep" }>): StepTaskInput | undefined {
  const definition = stepDefinition(record, effect.stepId);
  if (definition === undefined) return undefined;
  const target =
    definition.agent === undefined ? undefined : `${definition.agent.provider}/${definition.agent.model}`;
  const feedback = record.steps[definition.id]?.feedback;
  const prompt =
    definition.prompt === undefined ? undefined : renderFeedback(definition.prompt, feedback);
  return {
    runId: record.id,
    stepId: definition.id,
    attempt: effect.attempt,
    requestId: effect.requestId,
    cwd: record.worktree?.path ?? record.cwd,
    pollMs: definition.pollMs,
    timeoutMs: stepTimeoutMs(definition, record.inputs),
    retries: definition.retries,
    outcomes: definition.outcomes,
    outputs: Object.keys(definition.outputs),
    ...(target === undefined ? {} : { target }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(feedback === undefined ? {} : { feedback }),
  };
}

// ------------------------------------------------------------------ after-tasks

/**
 * `after` entries whose child must be created now: `auto` entries the reducer already moved to
 * `running` and that have no child task yet. A manual entry is never started here (FR11).
 */
function plannedAfterTasks(checkpoint: RunCheckpoint, now: number): PlannedAfterRun[] {
  const planned: PlannedAfterRun[] = [];
  for (const after of checkpoint.record.ir.after) {
    if (after.trigger !== "auto") continue;
    if (checkpoint.afterTasks[after.id] !== undefined) continue;
    const state = checkpoint.record.after[after.id];
    if (state === undefined || state.status !== "running") continue;
    planned.push(planAfterRun(checkpoint.record, after, now));
  }
  return planned;
}

// ------------------------------------------------------------------ error recovery

/**
 * Never abandon a run. A throwing phase (a bug or a transient store read) cancels the run through
 * the reducer, mirrors the terminal record, appends a `task_error` history line, reports the error,
 * and sends the task to `done` so it commits a failed outcome. If even that commit fails, the
 * original error propagates and pi-durable faults the task visibly.
 */
async function guarded<S extends RunCheckpoint>(
  task: RunningTask<RunTaskInput, S, RunTaskResult>,
  runtime: TaskRuntime<RunTaskInput, S, RunTaskResult, object>,
  context: Context,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (runtime.signal.aborted) throw error;
    runtime.report(error);
    const checkpoint = task.state.checkpoint;
    const now = runtime.now();
    const cancelled = next(checkpoint.record, { type: "cancel", now });
    const message = error instanceof Error ? error.message : String(error);
    const recovery = {
      ...checkpoint,
      phase: "done" as const,
      record: cancelled.record,
      awaiting: [] as readonly TaskId[],
      settles: [] as readonly StepSettlement[],
      gateSettles: [] as readonly GateSettlement[],
      finished: { status: "failed" as const, errorCode: "step_failed" as const },
    };
    try {
      await runtime.commit(
        async (tx) => {
          await writeRunState(tx, task.id, recovery.record, {
            type: "task_error",
            detail: message.slice(0, 500),
          });
          return {
            status: "running",
            checkpoint: recovery,
          } as NextTaskState<S, RunTaskResult>;
        },
        context,
      );
    } catch {
      throw error;
    }
  }
}

// ------------------------------------------------------------------ definition

export interface RunTaskOptions {
  readonly stepTask: StepTaskDefinition;
  readonly gateTask: GateTaskDefinition;
}

/**
 * Start one `argos.run` child as an after-task (FR11). Shared by the `done` phase (auto) and
 * `ArgosHost.startAfterTask` (manual) so both write the child mirror identically.
 */
export async function createAfterRunTask(
  tx: Tx,
  runTask: Task<RunTaskInput, RunCheckpoint, RunTaskResult, object>,
  planned: PlannedAfterRun,
  options: {
    readonly ownership: TaskOwnership;
    /** Required for a conversation-owned child created outside a task commit. */
    readonly conversationId?: ConversationId;
    readonly history?: NewHistoryEvent;
  },
): Promise<TaskId> {
  const childId = await tx.createTask(
    runTask,
    { runId: planned.record.id, record: planned.record, after: planned.link },
    {
      ownership: options.ownership,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    },
  );
  await writeRunState(tx, childId, planned.record, options.history ?? {
    type: "run_started",
    detail: planned.afterId,
  });
  return childId;
}

export function createRunTaskDefinition(options: RunTaskOptions) {
  const runTask = defineTask<RunTaskInput, RunCheckpoint, RunTaskResult>({
    name: "argos.run",
    version: 1,

    initial: (input): RunCheckpoint => ({
      phase: "select",
      record: input.record,
      childTasks: {},
      dispatched: {},
      awaiting: [],
      settles: [],
      gateTasks: {},
      gateSettles: [],
      afterTasks: {},
    }),

    phases: {
      select: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const now = runtime.now();
          const tick = next(checkpoint.record, { type: "tick", now });
          const live = await runtime.ownedTasks(context);
          const liveIds = new Set(live.map((child) => child.id as number));
          await runtime.commit(
            async (tx) =>
              planNext(
                tx,
                {
                  runTaskId: task.id,
                  checkpoint,
                  stepTask: options.stepTask,
                  gateTask: options.gateTask,
                  stepInput: (effect) => stepInputFor(tick.record, effect),
                },
                tick.record,
                tick.effects,
                now,
                liveIds,
              ),
            context,
          );
        });
      },

      await: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const now = runtime.now();
          const outcomes = await runtime.outcomes(checkpoint.awaiting, context);
          const settles: StepSettlement[] = [];
          const gateSettles: GateSettlement[] = [];
          const gateTasks: Record<string, TaskId> = { ...checkpoint.gateTasks };
          const gateByTask = new Map<number, string>();
          for (const [gateId, taskId] of Object.entries(checkpoint.gateTasks)) {
            gateByTask.set(Number(taskId), gateId);
          }
          for (const [index, outcome] of outcomes.entries()) {
            const taskId = checkpoint.awaiting[index];
            if (taskId === undefined) continue;
            const gateId = gateByTask.get(Number(taskId));
            if (gateId !== undefined) {
              const settlement = gateSettlementFrom(taskId, gateId, outcome);
              // A gate child that broke is forgotten so the `gate` phase opens a fresh one.
              if (settlement === undefined) delete gateTasks[gateId];
              else gateSettles.push(settlement);
              continue;
            }
            const settlement = settlementFrom(checkpoint, taskId, outcome);
            if (settlement !== undefined) settles.push(settlement);
          }
          const nextCheckpoint: RunCheckpoint = {
            ...checkpoint,
            phase: "settle",
            awaiting: [],
            settles,
            gateTasks,
            gateSettles,
          };
          await runtime.commit(
            async (tx) => {
              await writeRunState(tx, task.id, nextCheckpoint.record, {
                type: "settle",
                detail: `${settles.length} step(s), ${gateSettles.length} gate(s) settled`,
              });
              return { status: "running", checkpoint: nextCheckpoint };
            },
            context,
          );
        });
      },

      settle: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const now = runtime.now();
          if (checkpoint.settles.length === 0 && checkpoint.gateSettles.length === 0) {
            // Nothing settled (e.g. a broken gate child): re-select so the `gate` phase can repair.
            const reset: RunCheckpoint = {
              ...checkpoint,
              phase: "select",
              awaiting: [],
              settles: [],
              gateSettles: [],
            };
            await runtime.commit(
              async (tx) => {
                await writeRunState(tx, task.id, reset.record);
                return { status: "running", checkpoint: reset };
              },
              context,
            );
            return;
          }

          let record = checkpoint.record;
          const effects: Effect[] = [];
          for (const settlement of checkpoint.settles) {
            const result = next(record, stepEvents(settlement, now));
            record = result.record;
            effects.push(...result.effects);
          }
          for (const settlement of checkpoint.gateSettles) {
            const result = next(record, gateEvent(settlement, now));
            record = result.record;
            effects.push(...result.effects);
          }

          const live = await runtime.ownedTasks(context);
          const liveIds = new Set(live.map((child) => child.id as number));
          const settledGates = checkpoint.gateSettles;
          await runtime.commit(
            async (tx) => {
              for (const settlement of settledGates) {
                const gateStep = checkpoint.record.gates.find(
                  (gate) => gate.id === settlement.gateId,
                )?.stepId;
                await appendRunHistory(tx, record.id, record, {
                  type: "gate_decided",
                  ...(gateStep === undefined ? {} : { stepId: gateStep }),
                  detail: `${settlement.gateId} ${settlement.decision}`,
                });
              }
              return planNext(
                tx,
                {
                  runTaskId: task.id,
                  checkpoint: { ...checkpoint, settles: [], gateSettles: [] },
                  stepTask: options.stepTask,
                  gateTask: options.gateTask,
                  stepInput: (effect) => stepInputFor(record, effect),
                },
                record,
                effects,
                now,
                liveIds,
              );
            },
            context,
          );
        });
      },

      /**
       * Recovery path: every pending gate must have a live `argos.gate` child. Runs when the
       * reducer opened a gate but its child was lost (a crash between phases, or a broken child);
       * it never renumbers a gate id and never resets an already-decided document.
       */
      gate: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const pending = checkpoint.record.gates.filter((gate) => gate.status === "pending");
          const live = await runtime.ownedTasks(context);
          const liveIds = new Set(live.map((child) => child.id as number));
          const gateTasks: Record<string, TaskId> = {};
          for (const [gateId, taskId] of Object.entries(checkpoint.gateTasks)) {
            const gate = checkpoint.record.gates.find((candidate) => candidate.id === gateId);
            if (gate === undefined) continue;
            if (gate.status === "decided" || liveIds.has(Number(taskId))) gateTasks[gateId] = taskId;
          }
          await runtime.commit(
            async (tx) => {
              for (const gate of pending) {
                if (gateTasks[gate.id] !== undefined) continue;
                const childId = await tx.createTask(
                  options.gateTask,
                  gateInputFor(checkpoint.record, gate),
                  { ownership: { kind: "task", taskId: task.id } },
                );
                await openGateDoc(tx, checkpoint.record.id, gate);
                gateTasks[gate.id] = childId;
              }
              const on = pending
                .map((gate) => gateTasks[gate.id])
                .filter((taskId): taskId is TaskId => taskId !== undefined);
              const nextCheckpoint: RunCheckpoint = {
                ...checkpoint,
                phase: on.length > 0 ? "await" : "select",
                awaiting: on,
                settles: [],
                gateSettles: [],
                gateTasks,
              };
              await writeRunState(tx, task.id, nextCheckpoint.record, {
                type: "gate",
                detail: `reopened ${on.length} pending gate(s)`,
              });
              if (on.length > 0) {
                return { status: "waiting", on, policy: "allSettled", checkpoint: nextCheckpoint };
              }
              return { status: "running", checkpoint: nextCheckpoint };
            },
            context,
          );
        });
      },

      done: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const now = runtime.now();
          const finished =
            checkpoint.finished ??
            (checkpoint.record.status === "cancelled"
              ? { status: "cancelled" as const }
              : {
                  status: checkpoint.record.status === "failed" ? ("failed" as const) : ("completed" as const),
                  ...(checkpoint.record.outcome === undefined ? {} : { outcome: checkpoint.record.outcome }),
                  ...(checkpoint.record.errorCode === undefined ? {} : { errorCode: checkpoint.record.errorCode }),
                });

          // FR11: create the `auto` after-task children first, in their own commit. pi-durable
          // refuses new owned work in the commit that finishes the owner (spec §5.5), so the
          // children must exist before the terminal outcome is committed.
          const planned = plannedAfterTasks(checkpoint, now);
          if (planned.length > 0) {
            await runtime.commit(
              async (tx) => {
                const record = await mergeAfterFromMirror(tx, task.id, checkpoint.record);
                const afterTasks: Record<string, TaskId> = { ...checkpoint.afterTasks };
                for (const plan of planned) {
                  const childId = await createAfterRunTask(tx, runTask, plan, {
                    ownership: { kind: "task", taskId: task.id },
                    history: { type: "after_start", detail: plan.afterId },
                  });
                  afterTasks[plan.afterId] = childId;
                  await appendRunHistory(tx, record.id, record, {
                    type: "after_start",
                    detail: plan.afterId,
                  });
                }
                await writeRunState(tx, task.id, record);
                return {
                  status: "running",
                  checkpoint: { ...checkpoint, record, afterTasks, phase: "done" },
                };
              },
              context,
            );
            return;
          }

          const parentLink = task.input.after;
          const parentDoc =
            parentLink === undefined
              ? undefined
              : await runtime.snapshot(RunDocFamily, parentLink.parentRunId, context);
          const result: RunTaskResult = {
            runId: checkpoint.record.id,
            status: finished.status,
            ...(finished.outcome === undefined ? {} : { outcome: finished.outcome }),
            ...(finished.errorCode === undefined ? {} : { errorCode: finished.errorCode }),
          };
          await runtime.commit(
            async (tx) => {
              const record = await mergeAfterFromMirror(tx, task.id, checkpoint.record);
              if (parentLink !== undefined && parentDoc !== undefined) {
                await writeAfterStatus(tx, parentDoc, parentLink.afterId, {
                  status: finished.status === "completed" ? "completed" : "failed",
                  endedAt: now,
                });
              }
              await writeRunState(tx, task.id, record);
              if (finished.status === "completed") {
                return { status: "terminal", outcome: { status: "completed", result } };
              }
              if (finished.status === "cancelled") {
                return { status: "terminal", outcome: { status: "aborted", result } };
              }
              return {
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: {
                    message: finished.errorCode ?? "run_failed",
                    detail: { runId: checkpoint.record.id, status: finished.status },
                  },
                  result,
                },
              };
            },
            context,
          );
        });
      },
    },

    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      const now = runtime.now();
      // Cancellation goes through the reducer so the mirrored record is terminal too.
      const cancelled = next(checkpoint.record, { type: "cancel", now });
      const result: RunTaskResult = {
        runId: cancelled.record.id,
        status: cancelled.record.status === "completed" ? "completed" : "cancelled",
        ...(cancelled.record.errorCode === undefined ? {} : { errorCode: cancelled.record.errorCode }),
      };
      await runtime.commit(
        async (tx) => {
          const record = await mergeAfterFromMirror(tx, task.id, cancelled.record);
          await writeRunState(tx, task.id, record, {
            type: "finish",
            detail: "run aborted",
          });
          return { status: "terminal", outcome: { status: "aborted", result } };
        },
        context,
      );
    },
  });

  return runTask;
}

/** The task instance type, for the host's registry install. */
export type RunTask = ReturnType<typeof createRunTaskDefinition>;
