/**
 * The playbook graph projector (FR1–FR6): one pure function from a frozen `PlaybookIR` to the
 * deterministic node/edge set every renderer draws (`argos chart`, the web DAG view).
 *
 * The rules this module is built on:
 *
 * - **Pure.** No I/O, no clock, no `node:*`, no randomness. Two calls on one IR deep-equal, which
 *   is what lets a golden test pin the renderers.
 * - **Nothing private.** A node is `{id, title, kind, conditional?, group?}`, an edge is
 *   `{from, to, kind, label?, loop?, maxLoops?}`. No prompt, transcript, agent id, or request id
 *   can reach a renderer, and a `when` is a boolean badge rather than its expression.
 * - **`@end` is synthetic and last.** It exists only when a transition or a branch case ends the
 *   run, and it is the one id that is not a legal IR step id.
 * - **After steps are namespaced** (`after:<afterId>/<stepId>`): after ids are not namespaced in the
 *   IR, so a bare id would collide with a main step.
 * - **Loop marking is advisory.** A `goto`/`ask` whose target ranks at or before its source over
 *   `needs` edges is drawn as a loop. Nothing is removed: a same-rank forward jump stays a loop
 *   edge rather than reshaping the layout.
 * - **Choice-level routing is one edge.** An `ask` emits one edge per target with the `ask`
 *   transition's own target; the per-choice `goto` overrides the executor's destination, not the
 *   structure the diagram shows.
 *
 * The shapes come from `../rpc/contracts.js` as **types only**: `view/` may import the contract and
 * must not bundle the loader, so `contracts` never imports this module at runtime.
 */

import type { GraphEdge, GraphEdgeKind, GraphNode, PlaybookGraph } from "../rpc/contracts.js";
import type { PlaybookIR, StepIR, TransitionIR } from "./ir.js";

/** The synthetic end node (FR4). */
const END_NODE_ID = "@end";
/** Prefix of every after-task node id and group. */
const AFTER_PREFIX = "after:";

/** A step to project, the id it takes, and the graph scope it belongs to. */
interface ScopedStep {
  readonly step: StepIR;
  readonly nodeId: string;
  readonly scope: Scope;
}

/** The step ids of one graph (main or one after task) and how they are named as nodes. */
interface Scope {
  readonly ids: ReadonlySet<string>;
  readonly nodeId: (stepId: string) => string;
}

function nodeOf(step: StepIR, id: string, group: string | undefined): GraphNode {
  return {
    id,
    title: step.title,
    kind: step.kind,
    ...(step.when === undefined ? {} : { conditional: true }),
    ...(group === undefined ? {} : { group }),
  };
}

/**
 * Resolve one reference (a `needs` entry or a transition target) to the node ids it points at. A
 * block id resolves to its `entry[]`: `needs: [block]` is already rewritten to the block's
 * terminals by the loader, but `goto`/`ask.target` may still name the block itself (FR3).
 */
function targets(
  raw: string,
  scope: Scope,
  blocks: PlaybookIR["blocks"],
): readonly string[] {
  if (scope.ids.has(raw)) return [scope.nodeId(raw)];
  const block = blocks[raw];
  return block === undefined ? [raw] : block.entry;
}

/** The edges one transition contributes, before loop marking (FR3.2). */
function transitionEdges(
  from: string,
  outcome: string,
  transition: TransitionIR,
  resolve: (raw: string) => readonly string[],
): GraphEdge[] {
  switch (transition.kind) {
    case "complete":
      // The `needs` edge already carries the order; a plain completion draws nothing.
      return [];
    case "goto":
    case "ask": {
      const kind: GraphEdgeKind = transition.kind;
      // An empty outcome falls back to the target name; the `ask` question is prose and never a label.
      const label = outcome === "" ? transition.target : outcome;
      const maxLoops = transition.maxLoops;
      return resolve(transition.target).map((to) => ({
        from,
        to,
        kind,
        label,
        ...(maxLoops === undefined ? {} : { maxLoops }),
      }));
    }
    case "end":
      return [{ from, to: END_NODE_ID, kind: "end", label: transition.outcome ?? "end" }];
    case "fail":
      return [{ from, to: END_NODE_ID, kind: "fail", label: "fail" }];
  }
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareLabel(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return compareText(a, b);
}

/** FR5: edges sorted by `(from, to, kind, label)`, with `undefined` labels first. */
function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareText(a.from, b.from) ||
    compareText(a.to, b.to) ||
    compareText(a.kind, b.kind) ||
    compareLabel(a.label, b.label)
  );
}

/**
 * Project a frozen `PlaybookIR` to its graph (FR1–FR6). O(V+E), deterministic, and read-only: the
 * IR is never mutated and no extra key is ever needed to describe a playbook's shape.
 */
export function buildPlaybookGraph(ir: PlaybookIR): PlaybookGraph {
  const nodes: GraphNode[] = [];
  const scoped: ScopedStep[] = [];

  const mainIds = new Set(ir.steps.map((step) => step.id));
  const mainScope: Scope = { ids: mainIds, nodeId: (id) => id };
  for (const step of ir.steps) {
    nodes.push(nodeOf(step, step.id, step.use?.blockId));
    scoped.push({ step, nodeId: step.id, scope: mainScope });
  }

  for (const after of ir.after) {
    const group = `${AFTER_PREFIX}${after.id}`;
    const ids = new Set(after.steps.map((step) => step.id));
    const scope: Scope = { ids, nodeId: (id) => `${group}/${id}` };
    for (const step of after.steps) {
      const nodeId = `${group}/${step.id}`;
      nodes.push(nodeOf(step, nodeId, group));
      scoped.push({ step, nodeId, scope });
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const emit = (edge: GraphEdge): void => {
    // Two edges with the same `(from, to, kind, label)` are the same edge (a `goto` declared under
    // two outcomes, or two `end` transitions with the same label): emit it once.
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.label ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  // Rule 1: `needs`. The edge runs `dep -> step` (FR3.1) and these edges also define the rank loop
  // marking uses (FR6).
  const needsByNode = new Map<string, readonly string[]>();
  for (const entry of scoped) {
    const needs = entry.step.needs.flatMap((need) => targets(need, entry.scope, ir.blocks));
    needsByNode.set(entry.nodeId, needs);
    for (const dep of needs) emit({ from: dep, to: entry.nodeId, kind: "needs" });
  }

  // Longest path over `needs` edges only. `playbook_cycle` guarantees this graph is acyclic; the
  // `visiting` guard only keeps a hand-edited record from recursing forever.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const need of needsByNode.get(id) ?? []) {
      value = Math.max(value, rankOf(need) + 1);
    }
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  for (const node of nodes) rankOf(node.id);

  const isLoop = (edge: GraphEdge): boolean => {
    const fromRank = rank.get(edge.from);
    const toRank = rank.get(edge.to);
    if (fromRank === undefined || toRank === undefined) return false;
    return toRank <= fromRank;
  };

  /** FR6: only a `goto`/`ask` is ever marked, and an unmarked edge carries no `loop` key at all. */
  const withLoop = (edge: GraphEdge): GraphEdge =>
    edge.kind === "goto" || edge.kind === "ask"
      ? { ...edge, ...(isLoop(edge) ? { loop: true } : {}) }
      : edge;

  // Rule 2: `on.<outcome>` transitions, in IR order.
  for (const entry of scoped) {
    const resolve = (raw: string): readonly string[] => targets(raw, entry.scope, ir.blocks);
    for (const [outcome, transition] of Object.entries(entry.step.on)) {
      for (const edge of transitionEdges(entry.nodeId, outcome, transition, resolve)) {
        emit(withLoop(edge));
      }
    }
  }

  // Rule 3: a branch case that ends the run, in IR order (`branch` is a node kind, not an edge).
  for (const entry of scoped) {
    for (const item of entry.step.branch?.cases ?? []) {
      if (item.end === undefined) continue;
      emit({ from: entry.nodeId, to: END_NODE_ID, kind: "branch", label: item.name });
    }
  }

  // Rule 4 (FR4): the synthetic end node exists only when something targets it, and sorts last.
  if (edges.some((edge) => edge.to === END_NODE_ID)) {
    nodes.push({ id: END_NODE_ID, title: "end", kind: "end" });
  }

  // FR5: a fixed edge order, then entry/terminals over the non-loop edges.
  edges.sort(compareEdges);
  const forward = edges.filter((edge) => edge.loop !== true);
  const inbound = new Set(forward.map((edge) => edge.to));
  const outbound = new Set(forward.map((edge) => edge.from));

  return {
    nodes,
    edges,
    entry: nodes.filter((node) => !inbound.has(node.id)).map((node) => node.id),
    terminals: nodes.filter((node) => !outbound.has(node.id)).map((node) => node.id),
  };
}
