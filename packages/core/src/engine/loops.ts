/**
 * Loop accounting (FR15): how often a `goto` edge has been traversed and whether another
 * traversal is allowed.
 *
 * Semantics (deliberately literal, so tests can pin it):
 * - `max_loops: 2` allows **exactly two** returns through the edge. The third attempt does not
 *   traverse; it opens a loop-limit gate instead (never a silent pass).
 * - `loops[edge]` counts traversals; `loopAllowance[edge]` is the number of extra traversals a
 *   human approved on loop-limit gates. Traversal is allowed while
 *   `loops[edge] < maxLoops + loopAllowance[edge]`.
 * - `max_loops` absent means unlimited: no gate is ever opened for that edge.
 *
 * Edge label: `"<source>-><declaredTarget>"` (e.g. `"review->fix"`). The declared target is used
 * verbatim, so a `goto` to a sub-playbook block is `"review->myBlock"`, not one key per entry
 * step. No whitespace is added around `->`.
 */

import type { GateChoiceRecord, GateRecord, RunRecord } from "./record.js";

export function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}

export function parseEdgeKey(edge: string): { readonly source: string; readonly target: string } | undefined {
  const index = edge.indexOf("->");
  if (index <= 0 || index >= edge.length - 2) return undefined;
  return { source: edge.slice(0, index), target: edge.slice(index + 2) };
}

export interface LoopUsage {
  readonly edge: string;
  readonly loops: number;
  readonly allowance: number;
  /** `undefined` when the transition has no `max_loops` (unlimited). */
  readonly maxLoops: number | undefined;
  /** Traversals still allowed; `Infinity` when unlimited. */
  readonly remaining: number;
}

export function loopUsage(
  record: Pick<RunRecord, "loops" | "loopAllowance">,
  edge: string,
  maxLoops: number | undefined,
): LoopUsage {
  const loops = record.loops[edge] ?? 0;
  const allowance = record.loopAllowance[edge] ?? 0;
  const remaining = maxLoops === undefined ? Number.POSITIVE_INFINITY : maxLoops + allowance - loops;
  return { edge, loops, allowance, maxLoops, remaining };
}

/** Whether one more traversal of the edge is allowed (no gate needed). */
export function canTraverse(
  record: Pick<RunRecord, "loops" | "loopAllowance">,
  edge: string,
  maxLoops: number | undefined,
): boolean {
  return loopUsage(record, edge, maxLoops).remaining > 0;
}

/** Choices of a loop-limit gate. Only `approve` grants an allowance; every other decision rejects. */
export const LOOP_GATE_CHOICES: Readonly<Record<string, GateChoiceRecord>> = {
  approve: { label: "Run it once more", comment: "optional", color: "primary" },
  reject: { label: "Fail the step", comment: "required", color: "danger" },
};

export function loopGateQuestion(edge: string, maxLoops: number): string {
  return `Loop limit reached for "${edge}" (max_loops: ${maxLoops}). Approve to allow one more return, or reject to fail the step.`;
}

/**
 * D14 gate id for a loop-limit gate: `<stepId>:<n>` where `n` is the 1-based count of gates
 * already opened for the step (shared with step gates, so ids never collide within a step).
 */
export function loopGateId(record: Pick<RunRecord, "gates">, stepId: string): string {
  const count = record.gates.filter((gate: GateRecord) => gate.stepId === stepId).length;
  return `${stepId}:${count + 1}`;
}

/** True when this gate decision approves an extra traversal. */
export function isLoopGateApproval(decision: string): boolean {
  return decision === "approve";
}
