/**
 * `argos.run` v1 — the durable run state machine (FR13, FR14, FR15, FR29).
 *
 * Phases: `select → await → settle → gate → done` (static, so the definition never depends on
 * playbook content). The reducer `next()` is the **only** decision maker: this task feeds it
 * `tick` / `stepSettled` events and executes the returned effects (create one `argos.step` child
 * per `dispatchStep`, mirror the record, open/close the run). It never decides readiness,
 * transitions, loop limits, or timeouts itself.
 *
 * Atomicity: every state change commits the checkpoint **and** `argos.run.<runId>` **and**
 * `argos.history.<runId>` inside one `runtime.commit()`, so the mirror is never older than the
 * engine (FR13).
 *
 * Phase 4 scope:
 * - `gate` keeps the phase and sleeps on a 2 s poll (D7); decision handling is Phase 5.
 * - `startAfterTask` and `decisionRejected` effects are recorded as skipped history events with an
 *   explicit note. `scheduleWake` is reduced to a lower bound for the next poll. Nothing is
 *   silently dropped.
 * - A phase error is caught and turns into a cancelled, mirrored run plus a `task_error` history
 *   event and a failed task outcome, so a run is never abandoned without a terminal state.
 */

import { defineTask, type NextTaskState, type RunningTask, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
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
  type RunRecord,
} from "../../engine/index.js";
import { deepFreeze } from "../../playbook/ir.js";
import type { RunTaskResult, StepTaskResult } from "../context.js";
import { skippedEffectDetail, writeRunState, type NewHistoryEvent } from "../mirror.js";
import type { StepTaskInput, StepTaskDefinition } from "./step.js";

// ------------------------------------------------------------------ shape

export type RunPhase = "select" | "await" | "settle" | "gate" | "done";

/** D7: gate wake poll. */
export const GATE_POLL_MS = 2_000;

/** Defensive poll when the engine has no runnable step and no wake time. */
export const IDLE_POLL_MS = 1_000;

export interface RunTaskInput {
  readonly runId: string;
  /** The freshly created checkpoint; `initial()` copies it into the task checkpoint. */
  readonly record: RunRecord;
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

export interface RunFinished {
  readonly status: "completed" | "failed" | "cancelled";
  readonly outcome?: string;
  readonly errorCode?: ArgosErrorCode;
}

export interface RunCheckpointFields {
  readonly record: RunRecord;
  /** Latest child task per step id (goto re-runs replace the entry). */
  readonly childTasks: Readonly<Record<string, TaskId>>;
  /** Every child task id ever created for this run, keyed `String(taskId)` → step id. */
  readonly dispatched: Readonly<Record<string, string>>;
  /** Child task ids of the current wait. Empty outside `await`. */
  readonly awaiting: readonly TaskId[];
  /** Settlements carried from `await` into `settle`. */
  readonly settles: readonly StepSettlement[];
  /** Reserved for the Phase 5 `argos.gate` child tasks. */
  readonly gateTasks?: Readonly<Record<string, TaskId>>;
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
  gateTasks: z.record(z.string(), z.number().int().positive()).optional(),
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

// ------------------------------------------------------------------ helpers

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

function settlementFrom(
  checkpoint: RunCheckpoint,
  taskId: TaskId,
  outcome: { status: string; result?: unknown; error?: { message: string } },
  now: number,
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
  // `now` is unused for the settlement shape but keeps the signature symmetric with the engine.
  void now;
  return { ...base, errorCode: "step_failed" };
}

function historyForEffects(
  record: RunRecord,
  effects: readonly Effect[],
): NewHistoryEvent {
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
    return { type: "gate", stepId: gate.stepId, detail: gate.gateId };
  }
  return { type: "select" };
}

interface PlanContext {
  readonly runTaskId: TaskId;
  readonly checkpoint: RunCheckpoint;
  readonly stepTask: StepTaskDefinition;
  readonly stepInput: (effect: Extract<Effect, { type: "dispatchStep" }>) => StepTaskInput | undefined;
}

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
): Promise<
  | { readonly status: "running"; readonly checkpoint: RunCheckpoint }
  | { readonly status: "waiting"; readonly checkpoint: RunCheckpoint; readonly on: readonly TaskId[]; readonly policy: "allSettled" }
  | { readonly status: "sleeping"; readonly checkpoint: RunCheckpoint; readonly until: number }
> {
  const previous = plan.checkpoint;
  const childTasks: Record<string, TaskId> = { ...previous.childTasks };
  const dispatched: Record<string, string> = { ...previous.dispatched };
  const gateTasks: Record<string, TaskId> = { ...(previous.gateTasks ?? {}) };
  const waiting = new Set<TaskId>();
  let finished: RunFinished | undefined = previous.finished;
  let wakeAt: number | undefined;
  const skipped: NewHistoryEvent[] = [];

  for (const effect of effects) {
    switch (effect.type) {
      case "dispatchStep": {
        const input = plan.stepInput(effect);
        if (input === undefined) {
          skipped.push({
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
        // Phase 5 creates the `argos.gate` child task. The gate itself lives on the run record,
        // which is already mirrored, so the UI can show it now.
        skipped.push({
          type: "effect_skipped",
          stepId: effect.stepId,
          detail: skippedEffectDetail("openGate", `gate ${effect.gateId} awaits the Phase 5 gate task`),
        });
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
        skipped.push({
          type: "effect_skipped",
          detail: skippedEffectDetail("startAfterTask", `after-task ${effect.id} is Phase 5 work`),
        });
        break;
      }
      case "decisionRejected": {
        skipped.push({
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
    ...(finished === undefined ? {} : { finished }),
  };

  const history = historyForEffects(record, effects);
  await writeRunState(tx, plan.runTaskId, record, history);
  for (const skippedEvent of skipped) {
    // Same commit: the skip record lands with the checkpoint it describes.
    await writeRunState(tx, plan.runTaskId, record, skippedEvent);
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

  if (record.gates.some((gate) => gate.status === "pending")) {
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

/** Build the child task input from the frozen step definition. */
function stepInputFor(record: RunRecord, effect: Extract<Effect, { type: "dispatchStep" }>): StepTaskInput | undefined {
  const definition = stepDefinition(record, effect.stepId);
  if (definition === undefined) return undefined;
  const target =
    definition.agent === undefined ? undefined : `${definition.agent.provider}/${definition.agent.model}`;
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
    ...(definition.prompt === undefined ? {} : { prompt: definition.prompt }),
  };
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
}

export function createRunTaskDefinition(options: RunTaskOptions) {
  return defineTask<RunTaskInput, RunCheckpoint, RunTaskResult>({
    name: "argos.run",
    version: 1,

    initial: (input): RunCheckpoint => ({
      phase: "select",
      record: input.record,
      childTasks: {},
      dispatched: {},
      awaiting: [],
      settles: [],
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
          for (const [index, outcome] of outcomes.entries()) {
            const taskId = checkpoint.awaiting[index];
            if (taskId === undefined) continue;
            const settlement = settlementFrom(checkpoint, taskId, outcome, now);
            if (settlement !== undefined) settles.push(settlement);
          }
          const nextCheckpoint: RunCheckpoint = {
            ...checkpoint,
            phase: "settle",
            awaiting: [],
            settles,
          };
          await runtime.commit(
            async (tx) => {
              await writeRunState(tx, task.id, nextCheckpoint.record, {
                type: "settle",
                detail: `${settles.length} step(s) settled`,
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
          let record = checkpoint.record;
          const effects: Effect[] = [];
          for (const settlement of checkpoint.settles) {
            const result = next(record, stepEvents(settlement, now));
            record = result.record;
            effects.push(...result.effects);
          }
          const live = await runtime.ownedTasks(context);
          const liveIds = new Set(live.map((child) => child.id as number));
          await runtime.commit(
            async (tx) =>
              planNext(
                tx,
                {
                  runTaskId: task.id,
                  checkpoint: { ...checkpoint, settles: [] },
                  stepTask: options.stepTask,
                  stepInput: (effect) => stepInputFor(record, effect),
                },
                record,
                effects,
                now,
                liveIds,
              ),
            context,
          );
        });
      },

      gate: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const now = runtime.now();
          const pending = checkpoint.record.gates.some((gate) => gate.status === "pending");
          if (!pending) {
            // Nothing to wait for (the decision arrived in Phase 5): re-select immediately.
            const nextCheckpoint: RunCheckpoint = { ...checkpoint, phase: "select" };
            await runtime.commit(
              async (tx) => {
                await writeRunState(tx, task.id, nextCheckpoint.record);
                return { status: "running", checkpoint: nextCheckpoint };
              },
              context,
            );
            return;
          }
          // Phase 4: no decision channel yet. Sleep on the D7 poll and re-check. The mirror is
          // rewritten with the unchanged record so a reopened UI still has it.
          const until = now + GATE_POLL_MS;
          await runtime.commit(
            async (tx) => {
              await writeRunState(tx, task.id, checkpoint.record);
              return {
                status: "sleeping",
                until,
                checkpoint: { ...checkpoint, phase: "gate" },
              };
            },
            context,
          );
        });
      },

      done: async (task, runtime, context) => {
        await guarded(task, runtime, context, async () => {
          const checkpoint = task.state.checkpoint;
          const finished =
            checkpoint.finished ??
            (checkpoint.record.status === "cancelled"
              ? { status: "cancelled" as const }
              : {
                  status: checkpoint.record.status === "failed" ? ("failed" as const) : ("completed" as const),
                  ...(checkpoint.record.outcome === undefined ? {} : { outcome: checkpoint.record.outcome }),
                  ...(checkpoint.record.errorCode === undefined ? {} : { errorCode: checkpoint.record.errorCode }),
                });
          const result: RunTaskResult = {
            runId: checkpoint.record.id,
            status: finished.status,
            ...(finished.outcome === undefined ? {} : { outcome: finished.outcome }),
            ...(finished.errorCode === undefined ? {} : { errorCode: finished.errorCode }),
          };
          await runtime.commit(
            async (tx) => {
              await writeRunState(tx, task.id, checkpoint.record);
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
          await writeRunState(tx, task.id, cancelled.record, {
            type: "finish",
            detail: "run aborted",
          });
          return { status: "terminal", outcome: { status: "aborted", result } };
        },
        context,
      );
    },
  });
}

/** The task instance type, for the host's registry install. */
export type RunTask = ReturnType<typeof createRunTaskDefinition>;
