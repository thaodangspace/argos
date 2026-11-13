/**
 * `argos.delay` v1 — one child task per `kind: delay` step.
 *
 * A delay step pauses a run for a fixed time without a child process, so the pause survives an
 * `argos serve` restart. A `sleep 1800` script cannot: a restart kills the child, the resumed
 * `argos.script` task spawns it again for another full 1800 s, and the step deadline (absolute,
 * committed before the first spawn) fires first as `script_timeout`.
 *
 * Phases: `arm → wait`.
 *
 * - `arm` reads the clock once and commits `until = now + delayMs` together with a durable
 *   `sleeping`. That instant is the only clock decision: every later wake compares against the
 *   committed `until`, so a restart neither restarts the delay nor shortens it.
 * - `wait` runs on wake. Before `until` it parks again; at or after `until` (on time, or late
 *   because the host was down) it commits a **terminal completed** task whose result settles the
 *   step with its success outcome.
 *
 * Each park is at most {@link DELAY_SLICE_MS}: the harness timer is a Node timer, which on macOS
 * does not advance while the machine sleeps, so one 30-minute timer would fire late by however
 * long the laptop slept. Re-checking the wall clock every slice bounds that lateness to one slice.
 *
 * A delay step has no step timeout (`timedOutAttempts` skips it) and never fails on its own; an
 * unresolvable `{{ inputs.x }}` delay settles as `step_failed` with the reason. Cancelling the run
 * aborts the task like any other child.
 */

import { defineTask } from "@earendil-works/pi-durable";

import type { StepTaskResult } from "../context.js";

// ------------------------------------------------------------------ shape

export type DelayPhase = "arm" | "wait";

export interface DelayTaskInput {
  readonly runId: string;
  readonly stepId: string;
  /** Engine dispatch attempt (D14: the request id's last segment). */
  readonly attempt: number;
  readonly requestId: string;
  /** The delay as written in the IR (ms, duration string, or template), for the failure detail. */
  readonly delay: string | number;
  /** Resolved against the run inputs at dispatch; absent when the value did not resolve. */
  readonly delayMs?: number;
  readonly outcomes: readonly string[];
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type DelayCheckpoint =
  | { readonly phase: "arm"; readonly attempt: number }
  | {
      readonly phase: "wait";
      readonly attempt: number;
      /** When `arm` ran (`runtime.now()`). */
      readonly armedAt: number;
      /** Absolute epoch ms the step completes at; committed once, never recomputed. */
      readonly until: number;
    };

/** The task instance type the run task creates children from. */
export type DelayTaskDefinition = ReturnType<typeof createDelayTaskDefinition>;

/** Longest single park; each wake re-reads the wall clock (see the module comment). */
export const DELAY_SLICE_MS = 60_000;

/** Next park instant: the wake time, or one slice from now when that comes first. */
function parkUntil(now: number, until: number): number {
  return Math.min(until, now + DELAY_SLICE_MS);
}

/** The outcome an elapsed delay reports: `success` when declared, else the first outcome. */
export function delayOutcome(outcomes: readonly string[]): string {
  return outcomes.includes("success") ? "success" : (outcomes[0] ?? "success");
}

// ------------------------------------------------------------------ definition

export function createDelayTaskDefinition() {
  return defineTask<DelayTaskInput, DelayCheckpoint, StepTaskResult>({
    name: "argos.delay",
    version: 1,

    initial: (input): DelayCheckpoint => ({ phase: "arm", attempt: input.attempt }),

    phases: {
      arm: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const delayMs = task.input.delayMs;
        if (delayMs === undefined || !Number.isFinite(delayMs) || delayMs < 0) {
          const result: StepTaskResult = {
            stepId: task.input.stepId,
            attempt: checkpoint.attempt,
            requestId: task.input.requestId,
            errorCode: "step_failed",
            detail: `delay ${JSON.stringify(task.input.delay)} did not resolve to a duration`,
          };
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result } }),
            context,
          );
          return;
        }
        const armedAt = runtime.now();
        const until = armedAt + delayMs;
        await runtime.commit(
          () => ({
            status: "sleeping",
            until: parkUntil(armedAt, until),
            checkpoint: { phase: "wait", attempt: checkpoint.attempt, armedAt, until },
          }),
          context,
        );
      },

      wait: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        if (now < checkpoint.until) {
          await runtime.commit(
            () => ({ status: "sleeping", until: parkUntil(now, checkpoint.until), checkpoint }),
            context,
          );
          return;
        }
        const result: StepTaskResult = {
          stepId: task.input.stepId,
          attempt: checkpoint.attempt,
          requestId: task.input.requestId,
          outcome: delayOutcome(task.input.outcomes),
        };
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        );
      },
    },

    abort: async (task, runtime, context) => {
      const result: StepTaskResult = {
        stepId: task.input.stepId,
        attempt: task.state.checkpoint.attempt,
        requestId: task.input.requestId,
        errorCode: "step_failed",
      };
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result } }),
        context,
      );
    },
  });
}
