/**
 * `argos.step` v1 — one child task per launched step attempt.
 *
 * Phases: `locate → launch → await → collect` (FR16).
 *
 * - `locate` commits the launch intent (`requestId`, label, deadline) **before** any executor call.
 *   The intent lives in the checkpoint, so a restart reuses the same request id and the same
 *   attempt number, which is what makes `launch` an adopt-or-create decision instead of a
 *   duplicate agent.
 * - `launch` calls the injected {@link StepExecutor} and commits `agentId` immediately
 *   (the reconcile point).
 * - `await` parks in `sleeping(until: now + pollMs)`; it never holds a turn or a real timer.
 * - `collect` normalizes outputs and commits a **terminal** task with a {@link StepTaskResult}.
 *   A failed step is a completed task carrying an `errorCode`: task failure stays reserved for
 *   broken task code.
 *
 * Timeouts and retries are enforced here because the run task is parked in `waiting` on its
 * children and does not tick. `retries` counts *extra* attempts (engine semantics); each retry
 * gets a fresh `requestId` and a deterministic 1s/2s/4s… backoff. The run record still records one
 * dispatch attempt per child task; the step task's own retries are visible in its checkpoint and
 * history. (Phase 5/6 can move retry scheduling back into the engine once the host wakes parked
 * runs on backoff.)
 */

import { defineTask } from "@earendil-works/pi-durable";

import type { ArgosErrorCode } from "../../errors.js";
import type { Scalar } from "../../playbook/ir.js";
import { retryBackoffMs } from "../../engine/index.js";
import {
  launchLabel,
  stepRequestId,
  type AgentStatusInput,
  type CollectResult,
  type StepAgentStatus,
  type StepExecutor,
  type StepTaskResult,
} from "../context.js";

// ------------------------------------------------------------------ shape

export type StepPhase = "locate" | "launch" | "await" | "collect";

export interface StepTaskInput {
  readonly runId: string;
  readonly stepId: string;
  /** Engine dispatch attempt (D14: the task's first `requestId` uses it). */
  readonly attempt: number;
  readonly requestId: string;
  readonly cwd: string;
  /** D3 step poll default 3000 ms (resolved by the run task from the frozen IR). */
  readonly pollMs: number;
  readonly timeoutMs: number;
  /** Extra attempts after the first (engine semantics). */
  readonly retries: number;
  readonly target?: string;
  readonly prompt?: string;
  readonly outcomes: readonly string[];
  readonly outputs: readonly string[];
}

export interface StepCheckpointFields {
  readonly requestId: string;
  /** Current local attempt (may exceed the input attempt after a retry). */
  readonly attempt: number;
  readonly label: string;
  /** Absolute epoch ms after which this local attempt times out. */
  readonly deadlineAt: number;
  readonly polls: number;
  readonly agentId?: string;
  readonly target?: string;
  readonly launchedAt?: number;
  /** The polled result, carried into `collect`. */
  readonly status?: StepAgentStatus;
  readonly errorCode?: ArgosErrorCode;
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type StepCheckpoint =
  | (StepCheckpointFields & { readonly phase: "locate" })
  | (StepCheckpointFields & { readonly phase: "launch" })
  | (StepCheckpointFields & { readonly phase: "await" })
  | (StepCheckpointFields & { readonly phase: "collect" });

// ------------------------------------------------------------------ helpers

/** Race an executor promise against the invocation's abort signal (close/abort must not hang). */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("argos: invocation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("argos: invocation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Drop non-scalar outputs instead of corrupting the checkpoint; report `invalid_output`. */
function normalizeOutputs(
  outputs: Readonly<Record<string, unknown>> | undefined,
): { readonly outputs?: Readonly<Record<string, Scalar>>; readonly invalid: boolean } {
  if (outputs === undefined) return { invalid: false };
  const clean: Record<string, Scalar> = {};
  let invalid = false;
  for (const [key, value] of Object.entries(outputs)) {
    if (isScalar(value)) clean[key] = value;
    else invalid = true;
  }
  return invalid ? { invalid } : { outputs: clean, invalid };
}

function buildResult(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  collected: CollectResult,
): StepTaskResult {
  const normalized = normalizeOutputs(collected.outputs);
  const errorCode = normalized.invalid ? "invalid_output" : collected.errorCode;
  const result: Record<string, unknown> = {
    stepId: input.stepId,
    attempt: checkpoint.attempt,
    requestId: checkpoint.requestId,
  };
  if (collected.outcome !== undefined && errorCode === undefined) result["outcome"] = collected.outcome;
  if (normalized.outputs !== undefined) result["outputs"] = normalized.outputs;
  if (errorCode !== undefined) result["errorCode"] = errorCode;
  if (checkpoint.agentId !== undefined) result["agentId"] = checkpoint.agentId;
  if (checkpoint.target !== undefined) result["target"] = checkpoint.target;
  if (collected.usage !== undefined) result["usage"] = collected.usage;
  if (collected.feedback !== undefined) result["feedback"] = collected.feedback;
  return result as unknown as StepTaskResult;
}

function statusInput(input: StepTaskInput, checkpoint: StepCheckpoint, agentId: string): AgentStatusInput {
  return {
    requestId: checkpoint.requestId,
    agentId,
    label: checkpoint.label,
    runId: input.runId,
    stepId: input.stepId,
    attempt: checkpoint.attempt,
    cwd: input.cwd,
  };
}

/** Commit a "step done" checkpoint that `collect` turns into a terminal result. */
function doneCheckpoint(
  checkpoint: StepCheckpoint,
  status: StepAgentStatus,
): StepCheckpoint {
  return { ...checkpoint, phase: "collect", status };
}

// ------------------------------------------------------------------ definition

export interface StepTaskOptions {
  readonly executor: StepExecutor;
}

/** The task instance type the run task creates children from. */
export type StepTaskDefinition = ReturnType<typeof createStepTaskDefinition>;

export function createStepTaskDefinition(options: StepTaskOptions) {
  const { executor } = options;

  return defineTask<StepTaskInput, StepCheckpoint, StepTaskResult>({
    name: "argos.step",
    version: 1,
    initial: (input): StepCheckpoint => ({
      phase: "locate",
      requestId: input.requestId,
      attempt: input.attempt,
      label: launchLabel(input.runId, input.stepId, input.attempt),
      deadlineAt: 0,
      polls: 0,
      ...(input.target === undefined ? {} : { target: input.target }),
    }),

    phases: {
      locate: async (task, runtime, context) => {
        const now = runtime.now();
        const checkpoint: StepCheckpoint = {
          ...task.state.checkpoint,
          phase: "launch",
          deadlineAt: now + task.input.timeoutMs,
        };
        await runtime.commit(() => ({ status: "running", checkpoint }), context);
      },

      launch: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const launchInput = {
          requestId: checkpoint.requestId,
          label: checkpoint.label,
          runId: task.input.runId,
          stepId: task.input.stepId,
          attempt: checkpoint.attempt,
          cwd: task.input.cwd,
          outcomes: task.input.outcomes,
          outputs: task.input.outputs,
          ...(checkpoint.target === undefined ? {} : { target: checkpoint.target }),
          ...(task.input.prompt === undefined ? {} : { prompt: task.input.prompt }),
        };
        try {
          const launched = await withAbort(executor.launch(launchInput), runtime.signal);
          const next: StepCheckpoint = {
            ...checkpoint,
            phase: "await",
            agentId: launched.agentId,
            launchedAt: now,
            deadlineAt: now + task.input.timeoutMs,
            polls: 0,
            ...(launched.target === undefined ? {} : { target: launched.target }),
          };
          await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // Launch failed: record a step failure, not a task fault. Phase 6 adds the
          // `launch_uncertain` reconciliation escape hatch.
          const status: StepAgentStatus = { state: "done", errorCode: "step_failed" };
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
        }
      },

      await: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const agentId = checkpoint.agentId;
        if (agentId === undefined) {
          // Defensive: a checkpoint without an agent never polls.
          const status: StepAgentStatus = { state: "done", errorCode: "step_failed" };
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
          return;
        }

        let status: StepAgentStatus;
        try {
          status = await withAbort(
            Promise.resolve(executor.status(statusInput(task.input, checkpoint, agentId))),
            runtime.signal,
          );
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // A transient poll error behaves like "still running" and is bounded by the deadline.
          status = { state: "running" };
        }

        if (status.state === "done") {
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
          return;
        }

        if (now >= checkpoint.deadlineAt) {
          const canRetry = checkpoint.attempt < task.input.attempt + task.input.retries;
          if (!canRetry) {
            const timedOut: StepAgentStatus = { state: "done", errorCode: "step_timeout" };
            await runtime.commit(
              () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, timedOut) }),
              context,
            );
            return;
          }
          const attempt = checkpoint.attempt + 1;
          const backoff = retryBackoffMs(checkpoint.attempt);
          const retry: StepCheckpoint = {
            phase: "launch",
            requestId: stepRequestId(task.input.runId, task.input.stepId, attempt),
            attempt,
            label: launchLabel(task.input.runId, task.input.stepId, attempt),
            deadlineAt: now + backoff + task.input.timeoutMs,
            polls: 0,
            ...(checkpoint.target === undefined ? {} : { target: checkpoint.target }),
          };
          await runtime.commit(
            () => ({ status: "sleeping", until: now + backoff, checkpoint: retry }),
            context,
          );
          return;
        }

        const sleeping: StepCheckpoint = { ...checkpoint, polls: checkpoint.polls + 1 };
        await runtime.commit(
          () => ({ status: "sleeping", until: now + task.input.pollMs, checkpoint: sleeping }),
          context,
        );
      },

      collect: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const base: CollectResult =
          checkpoint.status === undefined || checkpoint.status.state === "running"
            ? { ...(checkpoint.errorCode === undefined ? {} : { errorCode: checkpoint.errorCode }) }
            : {
                ...(checkpoint.status.outcome === undefined ? {} : { outcome: checkpoint.status.outcome }),
                ...(checkpoint.status.outputs === undefined ? {} : { outputs: checkpoint.status.outputs }),
                ...(checkpoint.status.errorCode === undefined ? {} : { errorCode: checkpoint.status.errorCode }),
                ...(checkpoint.status.usage === undefined ? {} : { usage: checkpoint.status.usage }),
                ...(checkpoint.status.feedback === undefined ? {} : { feedback: checkpoint.status.feedback }),
              };

        let collected = base;
        if (executor.collect !== undefined && checkpoint.agentId !== undefined) {
          try {
            const refined = await withAbort(
              Promise.resolve(
                executor.collect({
                  ...statusInput(task.input, checkpoint, checkpoint.agentId),
                  status: checkpoint.status ?? { state: "done" },
                }),
              ),
              runtime.signal,
            );
            collected = {
              ...base,
              ...(refined.outcome === undefined ? {} : { outcome: refined.outcome }),
              ...(refined.outputs === undefined ? {} : { outputs: refined.outputs }),
              ...(refined.errorCode === undefined ? {} : { errorCode: refined.errorCode }),
              ...(refined.usage === undefined ? {} : { usage: refined.usage }),
              ...(refined.feedback === undefined ? {} : { feedback: refined.feedback }),
            };
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            // Keep the polled result; a broken collector must not lose the attempt.
          }
        }

        const result = buildResult(task.input, checkpoint, collected);
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        );
      },
    },

    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      const result: StepTaskResult = {
        stepId: task.input.stepId,
        attempt: checkpoint.attempt,
        requestId: checkpoint.requestId,
        errorCode: "step_failed",
      };
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result } }),
        context,
      );
    },
  });
}
