/**
 * Applying one settled step's transition (FR15), in the IR's declared shape:
 * `complete | end | fail | goto | ask`. This module mutates a draft record (already cloned by
 * the reducer) and appends effects; it never performs I/O and never reads the clock.
 *
 * Semantics pinned here:
 * - `on` is keyed by outcome. An outcome with **no** `on` entry is a plain `complete`; the set of
 *   outcomes itself was validated at load time. An outcome *not declared* by the step is a
 *   runtime error (`step_failed`) handled by the reducer before this module is called.
 * - `goto` re-queues the declared target **and every step transitively downstream of it**. This
 *   is what makes a loop re-run the whole affected sub-graph (`fix -> review -> verdict`) instead
 *   of only the target step. Outputs of re-queued steps are kept (they are only ever added).
 * - Feedback is attached to the target root steps as `StepRecord.feedback` for `{{ feedback }}`.
 * - Gate ids and loop allowance follow `loops.ts` (D14, `<stepId>:<n>`).
 */

import type { AskChoiceIR, BlockIR, GateChoiceIR, StepIR, TransitionIR } from "../playbook/ir.js";
import type { DraftRecord, GateChoiceRecord, GateRecord, RunRecord } from "./record.js";
import { nextGateId } from "./record.js";
import { edgeKey, isLoopGateApproval, LOOP_GATE_CHOICES, loopGateQuestion, loopUsage } from "./loops.js";
import { evaluateWhen } from "./ready.js";
import type { Effect } from "./reducer.js";

export interface TransitionInput {
  readonly stepId: string;
  readonly outcome: string;
  /** Feedback passed to the `goto` target (`{{ feedback }}`). */
  readonly feedback?: string;
  readonly now: number;
}

export interface GateDecisionInput {
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt: number;
  readonly now: number;
}

export interface FinishDetails {
  readonly outcome?: string;
  readonly errorCode?: RunRecord["errorCode"];
}

/** Strip `undefined` keys so the IR/record stays exact JSON. */
function plain<T>(value: Record<string, unknown>): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value as unknown as T;
}

// ------------------------------------------------------------------ run completion

/**
 * Move the run to a terminal status exactly once, emit `finishRun`, and start any `auto`
 * after-tasks for a completed/failed run. After-tasks never change `run.status` (FR11); the
 * reducer only records the start intent and emits `startAfterTask` for Phase 5.
 */
export function finishRun(
  draft: DraftRecord,
  status: "completed" | "failed" | "cancelled",
  now: number,
  effects: Effect[],
  details: FinishDetails = {},
): void {
  if (draft.status === "completed" || draft.status === "failed" || draft.status === "cancelled") {
    return;
  }
  draft.status = status;
  if (details.outcome !== undefined) draft.outcome = details.outcome;
  if (details.errorCode !== undefined) draft.errorCode = details.errorCode;
  effects.push(
    plain<Effect>({
      type: "finishRun",
      status,
      outcome: details.outcome,
      errorCode: details.errorCode,
    }),
  );

  if (status === "cancelled") return;
  for (const task of draft.ir.after) {
    const state = draft.after[task.id];
    if (state === undefined || state.status !== "pending") continue;
    if (task.trigger !== "auto") continue;
    state.status = "running";
    state.startedAt = now;
    effects.push({ type: "startAfterTask", id: task.id });
  }
}

// ------------------------------------------------------------------ transitions

/**
 * Apply the transition selected by `input.outcome`. The step was already moved to `completed`
 * by the caller (settle / branch / gate decision); this may move it to `failed` or `waiting`,
 * or reset it (and its downstream) via `goto`.
 */
export function applyTransition(draft: DraftRecord, input: TransitionInput, effects: Effect[]): void {
  const step = draft.steps[input.stepId];
  const definition = draft.ir.steps.find((candidate) => candidate.id === input.stepId);
  if (step === undefined || definition === undefined) return;

  step.outcome = input.outcome;
  if (input.feedback !== undefined) step.feedback = input.feedback;
  else delete step.feedback;
  step.status = "completed";

  const transition = definition.on[input.outcome];
  if (transition === undefined) {
    // No handler: the outcome selects nothing, so the step simply completes.
    return;
  }

  switch (transition.kind) {
    case "complete":
      return;
    case "end":
      finishRun(
        draft,
        "completed",
        input.now,
        effects,
        transition.outcome === undefined ? {} : { outcome: transition.outcome },
      );
      return;
    case "fail":
      step.status = "failed";
      step.errorCode = "step_failed";
      finishRun(draft, "failed", input.now, effects, { errorCode: "step_failed" });
      return;
    case "goto":
      step.status = "completed";
      applyGoto(draft, input.stepId, transition.target, transition.maxLoops, input.feedback, input.now, effects);
      return;
    case "ask":
      step.status = "waiting";
      openAskGate(draft, definition, transition, input, effects);
      return;
  }
}

/**
 * Traverse a goto edge, or open a loop-limit gate when `max_loops` is exhausted. Resetting the
 * downstream closure keeps the DAG semantics: every step that depends (transitively) on the
 * target must run again so the loop actually recomputes the verdict.
 */
export function applyGoto(
  draft: DraftRecord,
  sourceId: string,
  target: string,
  maxLoops: number | undefined,
  feedback: string | undefined,
  now: number,
  effects: Effect[],
): void {
  const roots = gotoRoots(draft, target);
  if (roots.length === 0) {
    const step = draft.steps[sourceId];
    if (step !== undefined) {
      step.status = "failed";
      step.errorCode = "step_failed";
    }
    finishRun(draft, "failed", now, effects, { errorCode: "step_failed" });
    return;
  }

  const edge = edgeKey(sourceId, target);
  const usage = loopUsage(draft, edge, maxLoops);
  if (usage.remaining <= 0 && maxLoops !== undefined) {
    openLoopGate(draft, sourceId, target, maxLoops, now, effects);
    return;
  }

  draft.loops[edge] = usage.loops + 1;
  const rootSet = new Set(roots);
  for (const id of downstreamClosure(draft.ir, roots)) {
    const step = draft.steps[id];
    if (step === undefined) continue;
    step.status = "pending";
    step.loop += 1;
    delete step.notBefore;
    delete step.outcome;
    delete step.errorCode;
    delete step.feedback;
  }
  if (feedback !== undefined) {
    for (const id of rootSet) {
      const step = draft.steps[id];
      if (step !== undefined) step.feedback = feedback;
    }
  }
}

/** Block ids address their whole sub-graph; step ids address themselves. */
function gotoRoots(draft: DraftRecord, target: string): readonly string[] {
  const block: BlockIR | undefined = draft.ir.blocks[target];
  if (block !== undefined) return block.stepIds;
  return draft.steps[target] === undefined ? [] : [target];
}

/**
 * The target plus every step that transitively `needs` a step in the set, in IR declaration
 * order. A dependency cycle is impossible in a validated IR; the fixed-point loop is bounded by
 * the step count for safety.
 */
export function downstreamClosure(ir: Pick<RunRecord["ir"], "steps">, roots: readonly string[]): readonly string[] {
  const reset = new Set(roots);
  for (let pass = 0; pass <= ir.steps.length; pass += 1) {
    let changed = false;
    for (const step of ir.steps) {
      if (reset.has(step.id)) continue;
      if (step.needs.some((need) => reset.has(need))) {
        reset.add(step.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ir.steps.filter((step) => reset.has(step.id)).map((step) => step.id);
}

// ------------------------------------------------------------------ branch

/**
 * A branch step is decided by the engine (FR21) and settles inside the same reducer event:
 * the first case whose `when` holds wins (the last case is the else). `end` on a case ends the
 * run; otherwise the case name is the outcome and is routed through `on`.
 */
export function settleBranch(draft: DraftRecord, definition: StepIR, now: number, effects: Effect[]): void {
  const state = draft.steps[definition.id];
  if (state === undefined) return;
  const record = draft as unknown as RunRecord;
  const chosen = definition.branch?.cases.find(
    (item) => item.when === undefined || evaluateWhen(item.when, record),
  );
  if (chosen === undefined) {
    state.status = "failed";
    state.errorCode = "step_failed";
    finishRun(draft, "failed", now, effects, { errorCode: "step_failed" });
    return;
  }
  delete state.notBefore;
  state.status = "completed";
  state.outcome = chosen.name;
  if (chosen.end !== undefined) {
    const outcome = chosen.end === true ? undefined : chosen.end;
    finishRun(draft, "completed", now, effects, outcome === undefined ? {} : { outcome });
    return;
  }
  applyTransition(draft, { stepId: definition.id, outcome: chosen.name, now }, effects);
}

// ------------------------------------------------------------------ gates

/** Open the human gate of a `kind: gate` step and park the step in `waiting`. */
export function openStepGate(draft: DraftRecord, definition: StepIR, now: number, effects: Effect[]): void {
  const state = draft.steps[definition.id];
  const gate = definition.gate;
  if (state === undefined) return;
  if (gate === undefined) {
    state.status = "failed";
    state.errorCode = "step_failed";
    finishRun(draft, "failed", now, effects, { errorCode: "step_failed" });
    return;
  }
  const id = nextGateId(draft, definition.id);
  const choices = mapChoices(gate.choices);
  const record: GateRecord = {
    id,
    kind: "step",
    stepId: definition.id,
    question: gate.question,
    choices,
    status: "pending",
    createdAt: now,
  };
  draft.gates.push(record);
  state.status = "waiting";
  delete state.notBefore;
  effects.push(plain<Effect>({ type: "openGate", gateId: id, kind: "step", stepId: definition.id, question: gate.question, choices }));
}

function openAskGate(
  draft: DraftRecord,
  definition: StepIR,
  transition: Extract<TransitionIR, { kind: "ask" }>,
  input: TransitionInput,
  effects: Effect[],
): void {
  const id = nextGateId(draft, definition.id);
  const choices = askChoices(transition.choices);
  const record = plain<GateRecord>({
    id,
    kind: "ask",
    stepId: definition.id,
    question: transition.ask,
    choices,
    status: "pending",
    createdAt: input.now,
    target: transition.target,
    maxLoops: transition.maxLoops,
  });
  draft.gates.push(record);
  effects.push(
    plain<Effect>({
      type: "openGate",
      gateId: id,
      kind: "ask",
      stepId: definition.id,
      question: transition.ask,
      choices,
    }),
  );
}

/** Loop-limit gate: the goto did not traverse; a human extends `loopAllowance` or fails the step. */
export function openLoopGate(
  draft: DraftRecord,
  sourceId: string,
  target: string,
  maxLoops: number,
  now: number,
  effects: Effect[],
): void {
  const id = nextGateId(draft, sourceId);
  const edge = edgeKey(sourceId, target);
  const question = loopGateQuestion(edge, maxLoops);
  const choices = mapChoices(LOOP_GATE_CHOICES);
  const record: GateRecord = {
    id,
    kind: "loop_limit",
    stepId: sourceId,
    question,
    choices,
    status: "pending",
    createdAt: now,
    edge,
    target,
    maxLoops,
  };
  draft.gates.push(record);
  const state = draft.steps[sourceId];
  if (state !== undefined) {
    state.status = "waiting";
    delete state.notBefore;
  }
  effects.push(
    plain<Effect>({
      type: "openGate",
      gateId: id,
      kind: "loop_limit",
      stepId: sourceId,
      question,
      choices,
      edge,
    }),
  );
}

function askChoices(
  choices: Readonly<Record<string, AskChoiceIR>> | undefined,
): Readonly<Record<string, GateChoiceRecord>> {
  if (choices === undefined || Object.keys(choices).length === 0) {
    return { continue: { label: "Continue", comment: "none" } };
  }
  const result: Record<string, GateChoiceRecord> = {};
  for (const [id, choice] of Object.entries(choices)) {
    result[id] = plain<GateChoiceRecord>({
      label: choice.label ?? id,
      comment: choice.comment,
      color: choice.color,
      goto: choice.goto,
      maxLoops: choice.maxLoops,
      outcome: choice.outcome,
      outputs: choice.outputs === undefined ? undefined : { ...choice.outputs },
    });
  }
  return result;
}

function mapChoices(
  choices: Readonly<Record<string, GateChoiceIR>>,
): Readonly<Record<string, GateChoiceRecord>> {
  const result: Record<string, GateChoiceRecord> = {};
  for (const [id, choice] of Object.entries(choices)) {
    result[id] = plain<GateChoiceRecord>({
      label: choice.label,
      comment: choice.comment,
      color: choice.color,
    });
  }
  return result;
}

/**
 * Apply one gate decision exactly once. Unknown gates and duplicate decisions are rejected with
 * an effect and do not change the checkpoint (Phase 5/8 surface the stable error code).
 *
 * - `step` gate: the decision id **is** the step outcome; its transition is applied.
 * - `ask` gate: the choice's `outcome` (re-route), else its `goto` (default: the ask target).
 * - `loop_limit` gate: `approve` grants one allowance and traverses; anything else fails the
 *   step with `step_failed`.
 *
 * The decision comment becomes goto feedback, so it reaches `{{ feedback }}` (FR15).
 */
export function applyGateDecision(draft: DraftRecord, input: GateDecisionInput, effects: Effect[]): void {
  const gate = draft.gates.find((candidate) => candidate.id === input.gateId);
  if (gate === undefined) {
    effects.push({ type: "decisionRejected", gateId: input.gateId, code: "gate_unknown" });
    return;
  }
  if (gate.status !== "pending") {
    effects.push({ type: "decisionRejected", gateId: input.gateId, code: "gate_already_decided" });
    return;
  }
  const choice = gate.choices[input.decision];
  if (choice === undefined) {
    // A decision outside the gate's choices cannot address this gate; Phase 8 validates first.
    effects.push({ type: "decisionRejected", gateId: input.gateId, code: "gate_unknown" });
    return;
  }

  gate.status = "decided";
  gate.decision = input.decision;
  if (input.comment !== undefined) gate.comment = input.comment;
  if (input.decidedBy !== undefined) gate.decidedBy = input.decidedBy;
  if (input.decidedVia !== undefined) gate.decidedVia = input.decidedVia;
  gate.decidedAt = input.decidedAt;

  const step = draft.steps[gate.stepId];
  if (step === undefined) {
    finishRun(draft, "failed", input.now, effects, { errorCode: "step_failed" });
    return;
  }
  const feedback = decisionFeedback(gate, input);

  if (gate.kind === "loop_limit") {
    if (isLoopGateApproval(input.decision) && gate.edge !== undefined && gate.target !== undefined && gate.maxLoops !== undefined) {
      draft.loopAllowance[gate.edge] = (draft.loopAllowance[gate.edge] ?? 0) + 1;
      step.status = "completed";
      applyGoto(draft, gate.stepId, gate.target, gate.maxLoops, feedback, input.now, effects);
    } else {
      step.status = "failed";
      step.errorCode = "step_failed";
      delete step.notBefore;
    }
    return;
  }

  step.status = "completed";
  delete step.notBefore;

  if (gate.kind === "step") {
    applyTransition(draft, { stepId: gate.stepId, outcome: input.decision, feedback, now: input.now }, effects);
    return;
  }

  if (choice.outputs !== undefined) {
    step.outputs = { ...step.outputs, ...choice.outputs };
  }
  if (choice.outcome !== undefined) {
    applyTransition(draft, { stepId: gate.stepId, outcome: choice.outcome, feedback, now: input.now }, effects);
    return;
  }
  if (choice.goto !== undefined || gate.target !== undefined) {
    applyGoto(
      draft,
      gate.stepId,
      choice.goto ?? gate.target ?? gate.stepId,
      choice.maxLoops ?? gate.maxLoops,
      feedback,
      input.now,
      effects,
    );
  }
}

function decisionFeedback(gate: GateRecord, input: GateDecisionInput): string {
  const base = `Gate "${gate.id}" decided "${input.decision}".`;
  return input.comment === undefined || input.comment === "" ? base : `${base} Comment: ${input.comment}`;
}
