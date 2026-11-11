/**
 * Timeouts (FR18) as pure helpers with an injected clock. Nothing here reads the clock, starts
 * a timer, or sleeps: the durable host calls `next(record, { type: "tick", now })` and this
 * module decides what has expired.
 *
 * Resolution: `timeout` is evaluated **at use time** from the frozen IR plus the run inputs:
 * - a number is milliseconds;
 * - a duration string (`"30m"`, `"90s"`, `"1h"`) is parsed by the same helper the loader uses;
 * - a whole-value template (`"{{ inputs.t }}"` / `"{{ playbook.inputs.t }}"`) reads the run input,
 *   which may itself be a number (ms) or a duration string;
 * - anything absent/unresolvable falls back to the 30 minute default. This keeps a bad timeout
 *   from crashing a live run; `argos validate`/input validation is the place to reject it early.
 *
 * Global deadline: `RunRecord.deadline` is an absolute epoch-ms instant. Reaching it fails the
 * run regardless of per-step retries.
 */

import { durationToMs } from "../playbook/resolve.js";
import type { Scalar, StepIR } from "../playbook/ir.js";
import type { RunRecord, StepRecord } from "./record.js";

/** The step `timeout` default from the spec (FR18). */
export const DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000;

/** Retry backoff: 1s, 2s, 4s, … capped at 60s. Deterministic, no jitter (replay-safe). */
export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRY_BACKOFF_MAX_MS = 60_000;

const TEMPLATE = /^\s*\{\{\s*(?:playbook\.)?inputs\.([A-Za-z_][\w-]*)\s*\}\}\s*$/;

/** Resolve a step timeout to milliseconds. See the module comment for the precedence. */
export function stepTimeoutMs(
  step: Pick<StepIR, "timeout">,
  inputs: Readonly<Record<string, Scalar>>,
): number {
  return resolveTimeoutValue(step.timeout, inputs) ?? DEFAULT_STEP_TIMEOUT_MS;
}

/** Exposed for tests and for Phase 4 input validation. */
export function resolveTimeoutValue(
  value: string | number | undefined,
  inputs: Readonly<Record<string, Scalar>>,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const template = TEMPLATE.exec(value);
  if (template !== null) {
    const input = inputs[template[1] ?? ""];
    if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : undefined;
    if (typeof input === "string") return durationToMs(input);
    return undefined;
  }
  return durationToMs(value);
}

export interface TimedOutAttempt {
  readonly stepId: string;
  readonly attempt: number;
  readonly deadline: number;
  readonly reason: "step_timeout";
}

/**
 * Attempts whose per-step deadline has passed. An attempt is in flight when it has `startedAt`
 * and no `endedAt`; the deadline is `startedAt + stepTimeoutMs(step, inputs)`.
 *
 * The global run deadline is intentionally separate (`runDeadlineReached`): it fails the whole
 * run and does not honor step retries.
 */
export function timedOutAttempts(record: RunRecord, now: number): readonly TimedOutAttempt[] {
  const result: TimedOutAttempt[] = [];
  for (const step of record.ir.steps) {
    const state = record.steps[step.id];
    if (state === undefined || state.status !== "running") continue;
    const inFlight = lastInFlightAttempt(state);
    if (inFlight === undefined) continue;
    const deadline = inFlight.startedAt + stepTimeoutMs(step, record.inputs);
    if (now >= deadline) {
      result.push({ stepId: step.id, attempt: inFlight.n, deadline, reason: "step_timeout" });
    }
  }
  return result;
}

export function lastInFlightAttempt(state: StepRecord): { readonly n: number; readonly startedAt: number } | undefined {
  for (let index = state.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = state.attempts[index];
    if (attempt === undefined) continue;
    if (attempt.endedAt === undefined) return attempt;
  }
  return undefined;
}

export function runDeadlineReached(record: Pick<RunRecord, "deadline">, now: number): boolean {
  return record.deadline !== undefined && now >= record.deadline;
}

/**
 * `retries` counts *extra* attempts: `retries: 1` means up to two launched attempts. A step may
 * retry while the number of recorded attempts is at most `retries`.
 */
export function canRetry(step: Pick<StepIR, "retries">, state: StepRecord): boolean {
  return state.attempts.length <= step.retries;
}

/** Delay before the next attempt; `attemptN` is the attempt that just failed. */
export function retryBackoffMs(attemptN: number): number {
  const exponent = Math.max(0, attemptN - 1);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** exponent, RETRY_BACKOFF_MAX_MS);
}
