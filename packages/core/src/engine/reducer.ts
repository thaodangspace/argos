/**
 * The pure reducer: `next(record, event) -> { record, effects }`.
 *
 * This is the whole Phase 3 contract. It has no I/O, no clock, no timers, and no imports from
 * the durable/Paseo layers: the host feeds it events (`tick` from a timer/sleep wake,
 * `stepSettled` from a child task, `gateDecided` from a decision) and executes the returned
 * effects (`dispatchStep`, `openGate`, `finishRun`, `startAfterTask`, …). Replaying the same
 * event sequence from the same checkpoint always yields the same record and effects.
 *
 * Main loop, all inside one event:
 *   committed settle/decision -> transition -> skip `when:false` -> open gates / settle branches
 *   -> dispatch ready steps within `concurrency` -> finish the run when everything is terminal.
 *
 * Never mutates the input: the reducer clones, mutates the clone, re-freezes, and returns a new
 * record. `seq` is bumped only when the record actually changes; `updatedAt` comes from the
 * event time (never read from the wall clock).
 */

import type { ArgosErrorCode } from "../errors.js";
import type { Scalar } from "../playbook/ir.js";
import type { DraftRecord, GateChoiceRecord, GateKind, RunRecord } from "./record.js";
import {
  cloneRecord,
  freezeRecord,
  isTerminalRunStatus,
  isTerminalStepStatus,
  stepDefinition,
} from "./record.js";
import { readySteps } from "./ready.js";
import {
  applyGateDecision,
  applyTransition,
  finishRun,
  openStepGate,
  settleBranch,
} from "./transition.js";
import { canRetry, lastInFlightAttempt, retryBackoffMs, runDeadlineReached, timedOutAttempts } from "./timeouts.js";

// ------------------------------------------------------------------ events

export type EngineEvent =
  | { readonly type: "tick"; readonly now: number }
  | {
      readonly type: "stepAttemptStarted";
      readonly stepId: string;
      /** 1-based attempt number; must match the `dispatchStep` effect. */
      readonly attempt: number;
      readonly startedAt: number;
      readonly agentId?: string;
      readonly target?: string;
      readonly requestId?: string;
      readonly now?: number;
    }
  | {
      readonly type: "stepSettled";
      readonly stepId: string;
      /** The agent/script outcome; must be one of `step.outcomes` unless `errorCode` is set. */
      readonly outcome?: string;
      readonly outputs?: Readonly<Record<string, Scalar>>;
      readonly errorCode?: ArgosErrorCode;
      readonly agentId?: string;
      readonly usage?: Readonly<Record<string, number>>;
      /** Feedback forwarded to the `goto` target (`{{ feedback }}`). */
      readonly feedback?: string;
      readonly endedAt: number;
      readonly now?: number;
    }
  | {
      readonly type: "gateDecided";
      readonly gateId: string;
      readonly decision: string;
      readonly comment?: string;
      readonly decidedBy?: string;
      readonly decidedVia?: string;
      readonly decidedAt: number;
      readonly now?: number;
    }
  | { readonly type: "cancel"; readonly now: number };

// ------------------------------------------------------------------ effects

/**
 * Everything the host must do after a transition. Effects are data: the reducer never executes
 * them. `scheduleWake` is a hint so the durable host can park in `sleeping` until a retry window
 * instead of polling.
 */
export type Effect =
  | {
      readonly type: "dispatchStep";
      readonly stepId: string;
      readonly attempt: number;
      /** D14: `argos:<runId>:<stepId>:<attempt>`, stable across restarts. */
      readonly requestId: string;
    }
  | {
      readonly type: "openGate";
      readonly gateId: string;
      readonly kind: GateKind;
      readonly stepId: string;
      readonly question: string;
      readonly choices: Readonly<Record<string, GateChoiceRecord>>;
      readonly edge?: string;
    }
  | {
      readonly type: "finishRun";
      readonly status: "completed" | "failed" | "cancelled";
      readonly outcome?: string;
      readonly errorCode?: ArgosErrorCode;
    }
  | { readonly type: "startAfterTask"; readonly id: string }
  | {
      readonly type: "decisionRejected";
      readonly gateId: string;
      readonly code: "gate_unknown" | "gate_already_decided";
    }
  | { readonly type: "scheduleWake"; readonly at: number };

export interface NextResult {
  readonly record: RunRecord;
  readonly effects: readonly Effect[];
}

// ------------------------------------------------------------------ reducer

export function next(record: RunRecord, event: EngineEvent): NextResult {
  // A terminal run is immutable; the only legal writes return `run_terminal` upstream (Phase 8).
  if (isTerminalRunStatus(record.status)) {
    return { record, effects: [] };
  }

  const effects: Effect[] = [];
  const draft = cloneRecord(record);
  switch (event.type) {
    case "tick":
      onTick(draft, event.now, effects);
      break;
    case "stepAttemptStarted":
      onAttemptStarted(draft, event);
      break;
    case "stepSettled":
      onSettled(draft, event, effects);
      break;
    case "gateDecided":
      applyGateDecision(
        draft,
        {
          gateId: event.gateId,
          decision: event.decision,
          decidedAt: event.decidedAt,
          now: event.now ?? event.decidedAt,
          ...(event.comment === undefined ? {} : { comment: event.comment }),
          ...(event.decidedBy === undefined ? {} : { decidedBy: event.decidedBy }),
          ...(event.decidedVia === undefined ? {} : { decidedVia: event.decidedVia }),
        },
        effects,
      );
      advance(draft, event.now ?? event.decidedAt, effects);
      break;
    case "cancel":
      onCancel(draft, event.now, effects);
      break;
  }

  if (JSON.stringify(draft) !== JSON.stringify(record)) {
    draft.seq = record.seq + 1;
    // Event times are monotonic by contract; never let a late event move `updatedAt` backwards.
    draft.updatedAt = Math.max(record.updatedAt, eventTime(event));
  }
  return { record: freezeRecord(draft), effects };
}

function eventTime(event: EngineEvent): number {
  switch (event.type) {
    case "tick":
    case "cancel":
      return event.now;
    case "stepAttemptStarted":
      return event.now ?? event.startedAt;
    case "stepSettled":
      return event.now ?? event.endedAt;
    case "gateDecided":
      return event.now ?? event.decidedAt;
  }
}

// ------------------------------------------------------------------ events

function onTick(draft: DraftRecord, now: number, effects: Effect[]): void {
  if (runDeadlineReached(draft, now)) {
    for (const definition of draft.ir.steps) {
      const step = draft.steps[definition.id];
      if (step === undefined) continue;
      if (step.status === "running") {
        const inFlight = lastInFlightAttempt(step);
        if (inFlight !== undefined) {
          const attempt = step.attempts.find((candidate) => candidate.n === inFlight.n);
          if (attempt !== undefined) {
            attempt.endedAt = now;
            attempt.outcome = "timeout";
            attempt.errorCode = "step_timeout";
          }
        }
        step.status = "failed";
        step.errorCode = "step_timeout";
      } else if (step.status === "pending" || step.status === "ready") {
        step.status = "skipped";
        delete step.notBefore;
      } else if (step.status === "waiting") {
        // A gate that never received a decision is dead once the run deadline passes.
        step.status = "failed";
        step.errorCode = "step_timeout";
      }
    }
    finishRun(draft, "failed", now, effects, { errorCode: "step_timeout" });
    return;
  }

  for (const timeout of timedOutAttempts(draft as unknown as RunRecord, now)) {
    const definition = stepDefinition(draft, timeout.stepId);
    const step = draft.steps[timeout.stepId];
    if (definition === undefined || step === undefined || step.status !== "running") continue;
    const attempt = step.attempts.find((candidate) => candidate.n === timeout.attempt);
    if (attempt !== undefined && attempt.endedAt === undefined) {
      attempt.endedAt = now;
      attempt.outcome = "timeout";
      attempt.errorCode = "step_timeout";
    }
    if (canRetry(definition, step)) {
      // Re-queue and expose `notBefore`; `readySteps` refuses to dispatch before it. The failed
      // attempt keeps its error; the pending retry does not look like a terminal error.
      step.status = "pending";
      delete step.errorCode;
      step.notBefore = now + retryBackoffMs(timeout.attempt);
      effects.push({ type: "scheduleWake", at: step.notBefore });
    } else {
      step.status = "failed";
      step.errorCode = "step_timeout";
    }
  }

  advance(draft, now, effects);
}

function onAttemptStarted(
  draft: DraftRecord,
  event: Extract<EngineEvent, { type: "stepAttemptStarted" }>,
): void {
  const step = draft.steps[event.stepId];
  if (step === undefined || isTerminalStepStatus(step.status)) return;
  if (step.status === "waiting") return; // a gate wait never owns an agent attempt
  if (step.status !== "running") step.status = "running";

  let attempt = step.attempts.find((candidate) => candidate.n === event.attempt);
  if (attempt === undefined) {
    attempt = { n: event.attempt, startedAt: event.startedAt };
    step.attempts.push(attempt);
    step.attempts.sort((left, right) => left.n - right.n);
  }
  if (attempt.endedAt !== undefined) return; // a late start event never reopens a settled attempt
  attempt.startedAt = event.startedAt;
  if (event.agentId !== undefined) attempt.agentId = event.agentId;
  if (event.target !== undefined) attempt.target = event.target;
  if (event.requestId !== undefined) attempt.requestId = event.requestId;
}

function onSettled(
  draft: DraftRecord,
  event: Extract<EngineEvent, { type: "stepSettled" }>,
  effects: Effect[],
): void {
  const definition = stepDefinition(draft, event.stepId);
  const step = draft.steps[event.stepId];
  if (definition === undefined || step === undefined) return;
  // Branch and gate steps settle inside the engine, never from a child task; a duplicate settle
  // after the step moved on is a no-op (idempotent event handling).
  if (definition.kind === "gate" || definition.kind === "branch") return;
  if (step.status !== "running") return;

  const inFlight = lastInFlightAttempt(step);
  let attempt = inFlight === undefined
    ? undefined
    : step.attempts.find((candidate) => candidate.n === inFlight.n);
  if (attempt === undefined) {
    attempt = { n: step.attempts.length + 1, startedAt: event.endedAt };
    step.attempts.push(attempt);
  }
  attempt.endedAt = event.endedAt;
  if (event.agentId !== undefined) attempt.agentId = event.agentId;
  if (event.usage !== undefined) attempt.usage = { ...event.usage };
  delete step.notBefore;
  delete step.feedback;

  if (event.errorCode !== undefined) {
    attempt.outcome = "failed";
    attempt.errorCode = event.errorCode;
    step.status = "failed";
    step.errorCode = event.errorCode;
    advance(draft, event.now ?? event.endedAt, effects);
    return;
  }

  const outcome = event.outcome;
  if (outcome === undefined || !definition.outcomes.includes(outcome)) {
    // Runtime unknown outcome (load-time validation already rejects declared ones).
    attempt.outcome = "failed";
    attempt.errorCode = "step_failed";
    step.status = "failed";
    step.errorCode = "step_failed";
    advance(draft, event.now ?? event.endedAt, effects);
    return;
  }

  attempt.outcome = "completed";
  delete step.errorCode;
  if (event.outputs !== undefined) step.outputs = { ...step.outputs, ...event.outputs };
  step.status = "completed";
  step.outcome = outcome;
  applyTransition(
    draft,
    {
      stepId: event.stepId,
      outcome,
      now: event.now ?? event.endedAt,
      ...(event.feedback === undefined ? {} : { feedback: event.feedback }),
    },
    effects,
  );
  advance(draft, event.now ?? event.endedAt, effects);
}

function onCancel(draft: DraftRecord, now: number, effects: Effect[]): void {
  for (const definition of draft.ir.steps) {
    const step = draft.steps[definition.id];
    if (step === undefined) continue;
    if (step.status === "pending" || step.status === "ready") {
      step.status = "skipped";
      delete step.notBefore;
      continue;
    }
    if (step.status !== "running" && step.status !== "waiting") continue;
    const inFlight = lastInFlightAttempt(step);
    if (inFlight !== undefined) {
      const attempt = step.attempts.find((candidate) => candidate.n === inFlight.n);
      if (attempt !== undefined) {
        attempt.endedAt = now;
        attempt.outcome = "cancelled";
      }
    }
    // Cancellation is not a step error: no `errorCode` is set.
    step.status = "failed";
    delete step.notBefore;
  }
  finishRun(draft, "cancelled", now, effects);
}

// ------------------------------------------------------------------ selection

const MAX_ADVANCE_ITERATIONS = 1_000;

/**
 * FR14 select: skip `when:false`, settle branches, open gate steps, then dispatch ready
 * non-gate steps. `concurrency` caps *simultaneously running* steps; gate waits do not hold a
 * slot. Steps that are eligible but over the cap are marked `ready` and picked up by a later
 * event (there is no `concurrency_limit` error here; the CLI-level refusal lives upstream).
 */
export function advance(draft: DraftRecord, now: number, effects: Effect[]): void {
  if (isTerminalRunStatus(draft.status)) return;

  for (let iteration = 0; iteration < MAX_ADVANCE_ITERATIONS; iteration += 1) {
    const { ready, skipped } = readySteps(draft as unknown as RunRecord, now);

    let skippedAny = false;
    for (const id of skipped) {
      const step = draft.steps[id];
      if (step !== undefined && (step.status === "pending" || step.status === "ready")) {
        step.status = "skipped";
        delete step.notBefore;
        skippedAny = true;
      }
    }
    if (skippedAny) continue;

    // Branches are decided by the engine and settle immediately, which may unlock more steps.
    let branchSettled = false;
    for (const id of ready) {
      const definition = stepDefinition(draft, id);
      if (definition?.kind !== "branch") continue;
      settleBranch(draft, definition, now, effects);
      branchSettled = true;
      break;
    }
    if (branchSettled) {
      if (isTerminalRunStatus(draft.status)) return;
      continue;
    }

    // Human gates: open every ready gate step (they do not consume a concurrency slot).
    for (const id of ready) {
      const definition = stepDefinition(draft, id);
      const step = draft.steps[id];
      if (definition?.kind !== "gate" || step === undefined) continue;
      if (step.status === "running" || step.status === "waiting") continue;
      openStepGate(draft, definition, now, effects);
    }

    const limit = draft.ir.concurrency ?? Number.POSITIVE_INFINITY;
    let running = countRunning(draft);
    for (const id of ready) {
      const definition = stepDefinition(draft, id);
      const step = draft.steps[id];
      if (definition === undefined || step === undefined) continue;
      if (definition.kind === "gate" || definition.kind === "branch") continue;
      if (step.status === "running" || step.status === "waiting" || isTerminalStepStatus(step.status)) {
        continue;
      }
      if (running >= limit) {
        step.status = "ready";
        continue;
      }
      dispatchStep(draft, definition.id, step, now, effects);
      running += 1;
    }
    break;
  }

  updateRunStatus(draft, now, effects);
}

function dispatchStep(
  draft: DraftRecord,
  stepId: string,
  step: DraftRecord["steps"][string],
  now: number,
  effects: Effect[],
): void {
  const attempt = step.attempts.length + 1;
  const requestId = `argos:${draft.id}:${stepId}:${attempt}`;
  step.status = "running";
  delete step.notBefore;
  delete step.errorCode;
  step.attempts.push({ n: attempt, startedAt: now, requestId });
  effects.push({ type: "dispatchStep", stepId, attempt, requestId });
}

function countRunning(draft: DraftRecord): number {
  let running = 0;
  for (const step of Object.values(draft.steps)) {
    if (step.status === "running") running += 1;
  }
  return running;
}

function updateRunStatus(
  draft: DraftRecord,
  now: number,
  effects: Effect[],
): void {
  if (isTerminalRunStatus(draft.status)) return;
  const steps = Object.values(draft.steps);

  const failed = steps.find((step) => step.status === "failed");
  if (failed !== undefined) {
    finishRun(
      draft,
      "failed",
      now,
      effects,
      failed.errorCode === undefined ? {} : { errorCode: failed.errorCode },
    );
    return;
  }

  if (steps.every((step) => step.status === "completed" || step.status === "skipped")) {
    finishRun(
      draft,
      "completed",
      now,
      effects,
      draft.outcome === undefined ? {} : { outcome: draft.outcome },
    );
    return;
  }

  const gatePending = draft.gates.some((gate) => gate.status === "pending");
  const active = steps.some((step) => step.status === "running" || step.status === "ready");
  draft.status = gatePending && !active ? "waiting" : "running";
}
