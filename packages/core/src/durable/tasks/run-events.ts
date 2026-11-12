/**
 * Child-outcome → engine-event mapping for `argos.run` (FR5.1 split of `tasks/run.ts`).
 *
 * The run task never decides anything: it translates a settled child (`argos.step` or `argos.gate`)
 * into the event the pure reducer understands, and records one bounded history line per effect.
 * Everything here is a pure function of the checkpoint and the child outcome.
 */

import type { TaskId } from "@earendil-works/pi-durable";

import type { Effect, EngineEvent } from "../../engine/index.js";
import type { GateTaskResult, StepTaskResult } from "../context.js";
import type { NewHistoryEvent } from "../mirror.js";

import type { GateSettlement, RunCheckpoint, StepSettlement } from "./run-checkpoint.js";

export function stepEvents(settlement: StepSettlement, now: number): EngineEvent {
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

export function gateEvent(settlement: GateSettlement, now: number): EngineEvent {
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

export function settlementFrom(
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
      ...(result.exhausted === undefined ? {} : { exhausted: result.exhausted }),
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
export function gateSettlementFrom(
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

/** One history line describing the effect the reducer just produced. */
export function historyForEffects(effects: readonly Effect[]): NewHistoryEvent {
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
