/**
 * The playbook graph projector (FR1–FR6): one test per derivation rule — nodes, the three edge
 * sources, block expansion, the synthetic `@end`, determinism, loop marking, and de-duplication —
 * plus the two shape fixtures a diagram is committed for (`compat/`, `subplaybook/`).
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { playbook, step } from "../engine/test-util.js";
import type { GraphEdge, PlaybookGraph } from "../rpc/contracts.js";
import { buildPlaybookGraph } from "./graph.js";
import type { BlockIR, PlaybookIR } from "./ir.js";
import { loadPlaybook } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const COMPAT = join(FIXTURES, "compat");
const SUB = join(FIXTURES, "subplaybook");

/** The four ordering fields of an edge, so an expectation reads as the diagram would. */
function tuples(graph: Pick<PlaybookGraph, "edges">) {
  return graph.edges.map((edge: GraphEdge) => [edge.from, edge.to, edge.kind, edge.label ?? null]);
}

const NODE_KEYS = ["conditional", "group", "id", "kind", "title"];
const EDGE_KEYS = ["from", "kind", "label", "loop", "maxLoops", "to"];

describe("buildPlaybookGraph: nodes (FR2)", () => {
  it("emits one node per step, in IR order, with its own title and kind", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "kinds",
        steps: [
          step({ id: "a", title: "Agent step" }),
          step({ id: "gate", title: "Gate", kind: "gate", needs: ["a"] }),
          step({ id: "script", title: "Script", kind: "script", needs: ["a"] }),
          step({ id: "delay", title: "Delay", kind: "delay", needs: ["a"] }),
          step({ id: "branch", title: "Branch", kind: "branch", needs: ["a"] }),
        ],
      }),
    );

    expect(graph.nodes).toStrictEqual([
      { id: "a", title: "Agent step", kind: "agent" },
      { id: "gate", title: "Gate", kind: "gate" },
      { id: "script", title: "Script", kind: "script" },
      { id: "delay", title: "Delay", kind: "delay" },
      { id: "branch", title: "Branch", kind: "branch" },
    ]);
  });

  it("marks a conditional step without publishing its `when` expression", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "conditional",
        steps: [
          step({ id: "always" }),
          step({ id: "maybe", needs: ["always"], when: { "steps.always.outcome": "success" } }),
        ],
      }),
    );

    expect(graph.nodes[1]).toStrictEqual({
      id: "maybe",
      title: "maybe",
      kind: "agent",
      conditional: true,
    });
    expect(graph.nodes[0]).not.toHaveProperty("conditional");
    expect(JSON.stringify(graph)).not.toContain("outcome");
  });

  it("namespaces an after step so it cannot shadow a main step id", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "afters",
        steps: [step({ id: "ship" }), step({ id: "done", needs: ["ship"] })],
        after: [
          {
            id: "cleanup",
            title: "Cleanup",
            trigger: "manual",
            steps: [
              step({ id: "ship" }),
              step({ id: "notify", needs: ["ship"], on: { failure: { kind: "fail" } } }),
            ],
          },
        ],
      }),
    );

    expect(graph.nodes.map((node) => node.id)).toStrictEqual([
      "ship",
      "done",
      "after:cleanup/ship",
      "after:cleanup/notify",
      "@end",
    ]);
    expect(graph.nodes[2]).toStrictEqual({
      id: "after:cleanup/ship",
      title: "ship",
      kind: "agent",
      group: "after:cleanup",
    });
    // `needs` and transitions of an after task stay inside their own namespace.
    expect(tuples(graph)).toContainEqual(["after:cleanup/ship", "after:cleanup/notify", "needs", null]);
    expect(tuples(graph)).toContainEqual(["after:cleanup/notify", "@end", "fail", "fail"]);
  });
});

describe("buildPlaybookGraph: edges (FR3)", () => {
  it("derives a `needs` edge per dependency, in IR step order (FR3.1)", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "diamond",
        steps: [
          step({ id: "plan" }),
          step({ id: "left", needs: ["plan"] }),
          step({ id: "right", needs: ["plan"] }),
          step({ id: "join", needs: ["left", "right"] }),
        ],
      }),
    );

    expect(tuples(graph)).toStrictEqual([
      ["left", "join", "needs", null],
      ["plan", "left", "needs", null],
      ["plan", "right", "needs", null],
      ["right", "join", "needs", null],
    ]);
    // FR5: the only source and the only sink.
    expect(graph.entry).toStrictEqual(["plan"]);
    expect(graph.terminals).toStrictEqual(["join"]);
  });

  it("derives an edge per transition kind and none for `complete` (FR3.2)", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "transitions",
        steps: [
          step({ id: "start" }),
          step({
            id: "decide",
            needs: ["start"],
            outcomes: ["yes", "no", "changes", "finished", "fail", "ok"],
            on: {
              yes: { kind: "goto", target: "work", maxLoops: 3 },
              no: { kind: "goto", target: "finish" },
              changes: { kind: "ask", ask: "Rework it?", target: "work", maxLoops: 2 },
              finished: { kind: "end", outcome: "finished" },
              fail: { kind: "fail" },
              ok: { kind: "complete" },
            },
          }),
          step({ id: "work", needs: ["decide"] }),
          step({ id: "finish", needs: ["work"] }),
        ],
      }),
    );

    // Sorted by `(from, to, kind, label)`: `to` comes before `kind` (FR5).
    expect(graph.edges.filter((edge) => edge.from === "decide" && edge.kind !== "needs")).toStrictEqual([
      { from: "decide", to: "@end", kind: "end", label: "finished" },
      { from: "decide", to: "@end", kind: "fail", label: "fail" },
      { from: "decide", to: "finish", kind: "goto", label: "no" },
      { from: "decide", to: "work", kind: "ask", label: "changes", maxLoops: 2 },
      { from: "decide", to: "work", kind: "goto", label: "yes", maxLoops: 3 },
    ]);
  });

  it("never uses the `ask` question as a label", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "ask",
        steps: [
          step({
            id: "review",
            outcomes: ["changes"],
            on: { changes: { kind: "ask", ask: "Ship the secret prompt?", target: "review" } },
          }),
        ],
      }),
    );

    expect(graph.edges).toStrictEqual([
      { from: "review", to: "review", kind: "ask", label: "changes", loop: true },
    ]);
    expect(JSON.stringify(graph)).not.toContain("secret prompt");
  });

  it("expands a block-qualified transition to every entry step (FR3)", () => {
    // What the loader produces for `use: tri`: the block stays addressable by id, its children are
    // inlined, and `needs: [tri]` is rewritten to the block's terminals.
    const block: BlockIR = {
      id: "tri",
      playbookId: "child",
      title: "Triangle",
      stepIds: ["tri.a", "tri.b", "tri.c"],
      entry: ["tri.a", "tri.b"],
      terminals: ["tri.c"],
      inputs: {},
      outputs: {},
      outcomes: [],
      on: {},
    };
    const ir: PlaybookIR = {
      ...playbook({
        id: "blocks",
        steps: [
          step({ id: "start" }),
          step({ id: "tri.a", needs: ["start"] }),
          step({ id: "tri.b", needs: ["start"] }),
          step({
            id: "tri.c",
            needs: ["tri.a", "tri.b"],
            outcomes: ["success", "again"],
            on: { again: { kind: "goto", target: "tri" } },
          }),
          step({ id: "finish", needs: ["tri.c"] }),
        ],
      }),
      blocks: { tri: block },
    };

    const graph = buildPlaybookGraph(ir);

    expect(graph.edges.filter((edge) => edge.kind === "goto")).toStrictEqual([
      { from: "tri.c", to: "tri.a", kind: "goto", label: "again", loop: true },
      { from: "tri.c", to: "tri.b", kind: "goto", label: "again", loop: true },
    ]);
    expect(graph.entry).toStrictEqual(["start"]);
    expect(graph.terminals).toStrictEqual(["finish"]);
  });

  it("derives a `branch` edge only for a case that ends the run (FR3.3)", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "branching",
        steps: [
          step({ id: "classify" }),
          step({
            id: "route",
            kind: "branch",
            needs: ["classify"],
            branch: {
              cases: [
                { name: "service", when: { "steps.classify.outputs.kind": "service" }, end: true },
                { name: "other" },
              ],
            },
          }),
          step({ id: "ship", needs: ["route"] }),
        ],
      }),
    );

    expect(graph.edges.filter((edge) => edge.kind === "branch")).toStrictEqual([
      { from: "route", to: "@end", kind: "branch", label: "service" },
    ]);
    expect(graph.nodes.map((node) => node.id)).toStrictEqual([
      "classify",
      "route",
      "ship",
      "@end",
    ]);
  });

  it("de-duplicates one edge declared twice and keeps distinct labels (FR3)", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "duplicates",
        steps: [
          // Both `stop` and `halt` end the run with the same label, so they are one edge.
          step({
            id: "a",
            outcomes: ["stop", "halt"],
            on: { stop: { kind: "end" }, halt: { kind: "end" } },
          }),
          // `x` and `y` jump to the same step with different labels, so both survive.
          step({
            id: "b",
            needs: ["a"],
            outcomes: ["x", "y"],
            on: { x: { kind: "goto", target: "b" }, y: { kind: "goto", target: "b" } },
          }),
        ],
      }),
    );

    expect(graph.edges.filter((edge) => edge.from === "a" && edge.kind === "end")).toStrictEqual([
      { from: "a", to: "@end", kind: "end", label: "end" },
    ]);
    expect(graph.edges.filter((edge) => edge.from === "b" && edge.kind === "goto")).toStrictEqual([
      { from: "b", to: "b", kind: "goto", label: "x", loop: true },
      { from: "b", to: "b", kind: "goto", label: "y", loop: true },
    ]);
  });
});

describe("buildPlaybookGraph: the synthetic end node (FR4)", () => {
  it("adds `@end` last only when something targets it", () => {
    const ending = buildPlaybookGraph(
      playbook({
        id: "ending",
        steps: [
          step({
            id: "one",
            outcomes: ["success", "failure"],
            on: { success: { kind: "end" }, failure: { kind: "fail" } },
          }),
        ],
      }),
    );

    expect(ending.nodes).toStrictEqual([
      { id: "one", title: "one", kind: "agent" },
      { id: "@end", title: "end", kind: "end" },
    ]);
    expect(ending.edges).toStrictEqual([
      { from: "one", to: "@end", kind: "end", label: "end" },
      { from: "one", to: "@end", kind: "fail", label: "fail" },
    ]);
    expect(ending.entry).toStrictEqual(["one"]);
    expect(ending.terminals).toStrictEqual(["@end"]);
  });

  it("never adds `@end` for a playbook with no `on` map at all", () => {
    const graph = buildPlaybookGraph(
      playbook({ id: "plain", steps: [step({ id: "one" }), step({ id: "two", needs: ["one"] })] }),
    );

    expect(graph.nodes.map((node) => node.id)).toStrictEqual(["one", "two"]);
    expect(graph.edges).toStrictEqual([{ from: "one", to: "two", kind: "needs" }]);
    expect(graph.terminals).toStrictEqual(["two"]);
  });});

describe("buildPlaybookGraph: loop marking (FR6)", () => {
  it("marks a `goto` back to an equal-or-lower rank as a loop and carries `max_loops`", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "loops",
        steps: [
          step({ id: "design" }),
          step({
            id: "impl",
            needs: ["design"],
            outcomes: ["success", "changes", "retry", "forward"],
            on: {
              changes: { kind: "goto", target: "design", maxLoops: 2 },
              retry: { kind: "goto", target: "impl" },
              forward: { kind: "goto", target: "ship" },
            },
          }),
          step({ id: "ship", needs: ["impl"] }),
        ],
      }),
    );

    expect(graph.edges.filter((edge) => edge.loop === true)).toStrictEqual([
      { from: "impl", to: "design", kind: "goto", label: "changes", maxLoops: 2, loop: true },
      { from: "impl", to: "impl", kind: "goto", label: "retry", loop: true },
    ]);
    // A same-rank or forward jump is never removed, and an unmarked edge carries no `loop` key.
    expect(graph.edges).toContainEqual({ from: "impl", to: "ship", kind: "goto", label: "forward" });
    // Loop edges are excluded from the entry/terminal computation.
    expect(graph.entry).toStrictEqual(["design"]);
    expect(graph.terminals).toStrictEqual(["ship"]);
  });

  it("marks a backward `ask` as a loop too", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "ask-loop",
        steps: [
          step({ id: "draft" }),
          step({
            id: "approve",
            kind: "gate",
            needs: ["draft"],
            outcomes: ["approve", "changes"],
            on: { changes: { kind: "ask", ask: "Reopen the draft?", target: "draft", maxLoops: 5 } },
          }),
        ],
      }),
    );

    expect(graph.edges).toStrictEqual([
      { from: "approve", to: "draft", kind: "ask", label: "changes", maxLoops: 5, loop: true },
      { from: "draft", to: "approve", kind: "needs" },
    ]);
    expect(graph.entry).toStrictEqual(["draft"]);
    expect(graph.terminals).toStrictEqual(["approve"]);
  });
});

describe("buildPlaybookGraph: determinism and shape (FR5)", () => {
  it("is deterministic, JSON-stable, and never mutates the IR", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const before = JSON.stringify(ir);

    const first = buildPlaybookGraph(ir);
    const second = buildPlaybookGraph(ir);

    expect(first).toStrictEqual(second);
    expect(JSON.stringify(ir)).toStrictEqual(before);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
  });

  it("carries nothing the read model refuses to publish", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const graph = buildPlaybookGraph(ir);
    const text = JSON.stringify(graph);

    for (const node of graph.nodes) {
      for (const key of Object.keys(node)) expect(NODE_KEYS).toContain(key);
    }
    for (const edge of graph.edges) {
      for (const key of Object.keys(edge)) expect(EDGE_KEYS).toContain(key);
    }
    // The IR holds the prompt; the graph must not.
    expect(JSON.stringify(ir)).toContain("Request:");
    expect(text).not.toContain("Request:");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("agentId");
  });
});

describe("buildPlaybookGraph: shape fixtures", () => {
  it("projects the compat pr fixture's loop edge with its max_loops (FR3, FR6)", () => {
    const graph = buildPlaybookGraph(loadPlaybook(COMPAT, "pr"));

    expect(graph.nodes.map((node) => node.id)).toStrictEqual([
      "investigate",
      "implement",
      "review",
      "local_qa",
      "babysit",
    ]);
    expect(graph.nodes.map((node) => node.kind)).toStrictEqual([
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    expect(graph.edges.filter((edge) => edge.loop === true)).toStrictEqual([
      {
        from: "babysit",
        to: "implement",
        kind: "goto",
        label: "changes_requested",
        maxLoops: 3,
        loop: true,
      },
    ]);
    expect(graph.entry).toStrictEqual(["investigate"]);
    expect(graph.terminals).toStrictEqual(["babysit"]);
    // `implement` feeds two parallel steps, and `babysit` waits for both.
    expect(tuples(graph).filter((edge) => edge[2] === "needs")).toStrictEqual([
      ["implement", "local_qa", "needs", null],
      ["implement", "review", "needs", null],
      ["investigate", "implement", "needs", null],
      ["local_qa", "babysit", "needs", null],
      ["review", "babysit", "needs", null],
    ]);
  });

  it("groups the inlined steps of a sub-playbook by their block id (FR2)", () => {
    const graph = buildPlaybookGraph(loadPlaybook(SUB, "parent"));

    expect(graph.nodes).toStrictEqual([
      { id: "pr.investigate", title: "investigate", kind: "agent", group: "pr" },
      { id: "pr.implement", title: "implement", kind: "agent", group: "pr" },
      { id: "finish", title: "finish", kind: "agent" },
    ]);
    expect(tuples(graph)).toStrictEqual([
      ["pr.implement", "finish", "needs", null],
      ["pr.investigate", "pr.implement", "needs", null],
    ]);
    expect(graph.entry).toStrictEqual(["pr.investigate"]);
    expect(graph.terminals).toStrictEqual(["finish"]);
  });
});
