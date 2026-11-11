/**
 * Readiness: which pending steps may be selected, and which ones `when` excludes.
 *
 * FR14/FR21: readiness is computed by the engine from the frozen IR and the checkpoint only.
 * No agent, model, or provider participates in this decision.
 *
 * A step is *ready* when:
 * 1. its status is `pending` (or `ready`, i.e. eligible but concurrency-blocked), and
 * 2. every `needs` entry is `completed` or `skipped` (a skipped dependency does not block),
 * 3. it is not waiting for a retry backoff window (`notBefore <= now`), and
 * 4. its `when` condition evaluates true.
 *
 * Steps whose dependencies are satisfied but whose `when` is false are *skipped* — the caller
 * commits that (the reducer does), which unblocks their dependents. Steps whose dependencies are
 * not satisfied yet are neither ready nor skipped.
 */

import type { StepRecord, RunRecord } from "./record.js";
import { isTerminalRunStatus, stepDefinitions } from "./record.js";
import type { Scalar, StepIR, WhenIR, WhenOperandIR } from "../playbook/ir.js";

export interface ReadySet {
  /** Step ids in IR declaration order. */
  readonly ready: readonly string[];
  /** Step ids whose `when` is false; the reducer marks them `skipped`. */
  readonly skipped: readonly string[];
}

/** `inputs.x` and `playbook.inputs.x` are the same run input; the latter is the canonical form. */
const PLAYBOOK_INPUT_PATH = /^(?:playbook\.)?inputs\.([A-Za-z_][\w-]*)$/;
const STEP_OUTPUT_PATH = /^steps\.([^.]+)\.outputs\.([A-Za-z_][\w-]*)$/;
const STEP_OUTCOME_PATH = /^steps\.([^.]+)\.outcome$/;
const STEP_STATUS_PATH = /^steps\.([^.]+)\.status$/;

/**
 * Compute the ready set for `now`. Pure: it never mutates the record and never writes statuses;
 * the reducer is the only writer.
 */
export function readySteps(record: RunRecord, now: number): ReadySet {
  if (isTerminalRunStatus(record.status)) return { ready: [], skipped: [] };

  const ready: string[] = [];
  const skipped: string[] = [];
  for (const step of stepDefinitions(record)) {
    const state = record.steps[step.id];
    if (state === undefined) continue;
    if (state.status !== "pending" && state.status !== "ready") continue;
    if (state.notBefore !== undefined && now < state.notBefore) continue;
    if (!needsSatisfied(record, step)) continue;
    if (step.when !== undefined && !evaluateWhen(step.when, record)) {
      skipped.push(step.id);
      continue;
    }
    ready.push(step.id);
  }
  return { ready, skipped };
}

function needsSatisfied(record: RunRecord, step: StepIR): boolean {
  for (const need of step.needs) {
    const dependency = record.steps[need];
    // An unknown need cannot happen for a validated IR; treat it as unsatisfied rather than ready.
    if (dependency === undefined) return false;
    if (dependency.status !== "completed" && dependency.status !== "skipped") return false;
  }
  return true;
}

// ------------------------------------------------------------------ conditions

/** FR21: every key of a `when` map must hold (logical AND). */
export function evaluateWhen(when: WhenIR, record: RunRecord): boolean {
  for (const [path, operand] of Object.entries(when)) {
    if (!matches(readCondition(record, path), operand)) return false;
  }
  return true;
}

/**
 * Resolve one condition path against the checkpoint.
 *
 * Supported paths:
 * - `steps.<id>.outputs.<name>` — a collected output
 * - `steps.<id>.outcome`        — the outcome of the latest settled attempt
 * - `steps.<id>.status`         — extension, e.g. `{ skipped }` checks
 * - `playbook.inputs.<name>` / `inputs.<name>` — a run input
 *
 * An unknown path resolves to `undefined`; use `{ empty: true }` to test for absence.
 */
export function readCondition(record: RunRecord, path: string): Scalar | undefined {
  const inputMatch = PLAYBOOK_INPUT_PATH.exec(path);
  if (inputMatch !== null) {
    const name = inputMatch[1] ?? "";
    return record.inputs[name];
  }
  const outputMatch = STEP_OUTPUT_PATH.exec(path);
  if (outputMatch !== null) {
    const stepId = outputMatch[1] ?? "";
    const output = outputMatch[2] ?? "";
    return record.steps[stepId]?.outputs[output];
  }
  const outcomeMatch = STEP_OUTCOME_PATH.exec(path);
  if (outcomeMatch !== null) {
    return record.steps[outcomeMatch[1] ?? ""]?.outcome;
  }
  const statusMatch = STEP_STATUS_PATH.exec(path);
  if (statusMatch !== null) {
    return record.steps[statusMatch[1] ?? ""]?.status;
  }
  return undefined;
}

/**
 * Operand semantics:
 * - scalar: strict equality with the resolved value;
 * - array: the resolved value is one of the entries (strict);
 * - `{ empty: true }`: the value is absent, `""`, or an empty collection;
 *   `{ empty: false }`: the value is present and non-empty.
 */
export function matches(value: Scalar | undefined, operand: WhenOperandIR): boolean {
  if (isScalarArray(operand)) {
    return operand.some((candidate) => candidate === value);
  }
  if (isEmptinessOperand(operand)) {
    return isEmpty(value) === operand.empty;
  }
  return value === operand;
}

function isScalarArray(operand: WhenOperandIR): operand is readonly Scalar[] {
  return Array.isArray(operand);
}

function isEmptinessOperand(operand: WhenOperandIR): operand is { readonly empty: boolean } {
  return typeof operand === "object" && operand !== null && "empty" in operand;
}

/** Absent, empty string, empty array/object. Numbers and booleans (including 0/false) are present. */
export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** Test helper surface: whether a step's status counts as "done" for dependency purposes. */
export function isDependencyDone(state: StepRecord | undefined): boolean {
  return state?.status === "completed" || state?.status === "skipped";
}
