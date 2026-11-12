/**
 * Error recovery for `argos.run` (FR5.1 split of `tasks/run.ts`).
 *
 * Never abandon a run. A throwing phase (a bug or a transient store read) cancels the run through
 * the reducer, mirrors the terminal record, appends a `task_error` history line, reports the error,
 * and sends the task to `done` so it commits a failed outcome. If even that commit fails, the
 * original error propagates and pi-durable faults the task visibly.
 */

import type { Context } from "@earendil-works/chord/context";
import type {
  NextTaskState,
  RunningTask,
  TaskId,
  TaskRuntime,
} from "@earendil-works/pi-durable";

import { next } from "../../engine/index.js";
import type { RunTaskResult } from "../context.js";
import { writeRunState } from "../mirror.js";

import type {
  GateSettlement,
  RunCheckpoint,
  RunTaskInput,
  StepSettlement,
} from "./run-checkpoint.js";

export async function guarded<S extends RunCheckpoint>(
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
