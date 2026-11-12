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
 *
 * FR5.1: the checkpoint shape (`run-checkpoint.ts`), the child-outcome mapping (`run-events.ts`),
 * the effect → task-state planning (`run-plan.ts`), and the error recovery (`run-recovery.ts`) live
 * in sibling modules. Behavior and this module's export surface are unchanged.
 */

import { defineTask, type TaskId } from "@earendil-works/pi-durable";

import { next, type Effect } from "../../engine/index.js";
import type { RunTaskResult } from "../context.js";
import {
  appendRunHistory,
  mergeAfterFromMirror,
  openGateDoc,
  writeAfterStatus,
  writeRunState,
  RunDocFamily,
} from "../mirror.js";
import { createAfterRunTask, plannedAfterTasks } from "./after.js";
import type { GateTaskDefinition } from "./gate.js";
import type {
  GateSettlement,
  RunCheckpoint,
  RunTaskInput,
  StepSettlement,
} from "./run-checkpoint.js";
import { gateEvent, gateSettlementFrom, settlementFrom, stepEvents } from "./run-events.js";
import { dispatchPlanFor, gateInputFor, mergeExhausted, planNext } from "./run-plan.js";
import { guarded } from "./run-recovery.js";
import type { ScriptTaskDefinition } from "./script.js";
import type { StepTaskDefinition } from "./step.js";

// ------------------------------------------------------------------ definition

export interface RunTaskOptions {
  readonly stepTask: StepTaskDefinition;
  readonly scriptTask: ScriptTaskDefinition;
  readonly gateTask: GateTaskDefinition;
  /**
   * `$ARGOS_HOME`, threaded like the executor so a global script under `<home>/scripts` resolves.
   * Never stored on the record: the frozen IR and every checkpoint stay unchanged.
   */
  readonly home?: string;
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
      ...(input.clientRequestId === undefined
        ? {}
        : { lastClientRequestId: input.clientRequestId }),
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
                  scriptTask: options.scriptTask,
                  gateTask: options.gateTask,
                  dispatch: (effect) => dispatchPlanFor(tick.record, effect, options.home),
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

          // FR24: the step executor owns quota detection; the run record owns the durable ledger.
          const exhausted = mergeExhausted(
            record.exhausted,
            checkpoint.settles.flatMap((settlement) => settlement.exhausted ?? []),
          );
          if (exhausted !== record.exhausted) {
            record = {
              ...record,
              exhausted,
              updatedAt: Math.max(record.updatedAt, now),
              seq: record.seq + 1,
            };
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
                  scriptTask: options.scriptTask,
                  gateTask: options.gateTask,
                  dispatch: (effect) => dispatchPlanFor(record, effect, options.home),
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

// ------------------------------------------------------------------ re-exports

// The split is a pure move: everything this module exported before is still exported here, by
// name (never `export *`), so `argos-core/durable` keeps exactly the same surface.
export {
  IDLE_POLL_MS,
  InvalidRunCheckpointError,
  RunCheckpointSchema,
  hydrateRunCheckpoint,
} from "./run-checkpoint.js";
export type {
  GateSettlement,
  RunCheckpoint,
  RunCheckpointFields,
  RunFinished,
  RunPhase,
  RunTaskInput,
  StepSettlement,
} from "./run-checkpoint.js";
export { createAfterRunTask } from "./after.js";
export { renderFeedback } from "./run-plan.js";
