/**
 * Gate decision validation and application (FR19, FR20, FR22). **Pure**: no I/O, no clock, no
 * timers, no durable imports — the same reducer the engine uses is the only state machine here.
 *
 * The durable host calls this inside one atomic write commit, before it stores the decision
 * document, so an invalid decision never reaches the channel:
 *
 * - `gate_unknown` — the gate id is not on the record, or the decision is not one of its choices
 *   (the reducer treats an out-of-choice decision the same way, so the two layers agree);
 * - `gate_already_decided` — the gate already has a decision; the message names the winning one;
 * - `run_terminal` — the run is finished, so no decision may be applied (a write on a finished run).
 *
 * On success it returns the record/effects that the `gateDecided` event produced through
 * `next()`, so the host can persist the exact same state the durable run task would compute.
 */

import type { Effect } from "./reducer.js";
import { next } from "./reducer.js";
import { isTerminalRunStatus, type GateRecord, type RunRecord } from "./record.js";

export type GateDecisionRejection = "gate_unknown" | "gate_already_decided" | "run_terminal";

export interface GateDecisionRequest {
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  /** When the human/role decided (absolute epoch ms). */
  readonly decidedAt: number;
  /** Event time for the reducer; defaults to `decidedAt`. */
  readonly now?: number;
}

export interface GateDecisionPlan {
  /** The record after the decision, or the input record unchanged on a rejection. */
  readonly record: RunRecord;
  readonly effects: readonly Effect[];
  /** The gate the decision addressed, when it exists. */
  readonly gate?: GateRecord;
  /** Set when the decision was refused; `record`/`effects` then carry no change. */
  readonly rejection?: {
    readonly code: GateDecisionRejection;
    readonly message: string;
  };
}

export function decideGate(record: RunRecord, request: GateDecisionRequest): GateDecisionPlan {
  const { gateId, decision } = request;

  if (isTerminalRunStatus(record.status)) {
    return {
      record,
      effects: [],
      rejection: {
        code: "run_terminal",
        message: `run ${record.id} is ${record.status}; gate ${gateId} can no longer be decided`,
      },
    };
  }

  const gate = record.gates.find((candidate) => candidate.id === gateId);
  if (gate === undefined) {
    return {
      record,
      effects: [{ type: "decisionRejected", gateId, code: "gate_unknown" }],
      rejection: {
        code: "gate_unknown",
        message: `run ${record.id}: unknown gate "${gateId}"`,
      },
    };
  }

  if (gate.status !== "pending") {
    const winner = gate.decision === undefined ? "unknown" : `"${gate.decision}"`;
    const at = gate.decidedAt === undefined ? "an earlier time" : `${gate.decidedAt}`;
    return {
      record,
      effects: [{ type: "decisionRejected", gateId, code: "gate_already_decided" }],
      gate,
      rejection: {
        code: "gate_already_decided",
        message: `gate ${gateId} was already decided ${winner} at ${at}`,
      },
    };
  }

  if (gate.choices[decision] === undefined) {
    const choices = Object.keys(gate.choices).join(", ");
    return {
      record,
      effects: [{ type: "decisionRejected", gateId, code: "gate_unknown" }],
      gate,
      rejection: {
        code: "gate_unknown",
        message: `gate ${gateId}: "${decision}" is not one of [${choices}]`,
      },
    };
  }

  const result = next(record, {
    type: "gateDecided",
    gateId,
    decision,
    decidedAt: request.decidedAt,
    ...(request.comment === undefined ? {} : { comment: request.comment }),
    ...(request.decidedBy === undefined ? {} : { decidedBy: request.decidedBy }),
    ...(request.decidedVia === undefined ? {} : { decidedVia: request.decidedVia }),
    ...(request.now === undefined ? {} : { now: request.now }),
  });
  return { record: result.record, effects: result.effects, gate };
}
