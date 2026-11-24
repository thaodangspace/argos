/**
 * The Mermaid renderer (FR13–FR16): the escaping table per character, the stable node keys (D6,
 * D7), the node/edge/subgraph/classDef shapes, the `--run` decoration join, and the three committed
 * diagrams a wiring change is supposed to show up in.
 *
 * The goldens are regenerated deliberately:
 * `UPDATE_GOLDEN=1 npx vitest run --project core packages/core/test/view/graph.test.ts`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { playbook, step } from "../../src/engine/test-util.js";
import { buildPlaybookGraph } from "../../src/playbook/graph.js";
import { loadPlaybook } from "../../src/playbook/load.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import type { PlaybookGraph } from "../../src/rpc/contracts.js";
import {
  decorateGraph,
  escapeMermaidLabel,
  layerGraph,
  mermaidNodeKey,
  renderMermaid,
  type GraphLayout,
  type LayoutNode,
} from "../../src/view/index.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const GOLDEN_DIR = join(FIXTURES, "graph");
const SUBPLAYBOOK = join(FIXTURES, "subplaybook");

/** Write-or-compare, the same convention the CLI golden tests use. */
function expectGolden(name: string, text: string): void {
  const file = join(GOLDEN_DIR, name);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text, "utf8");
  }
  if (!existsSync(file)) throw new Error(`missing golden ${file}; run with UPDATE_GOLDEN=1`);
  expect(text).toBe(readFileSync(file, "utf8"));
}

/** One linear playbook with a `max_loops` jump and an `end`, the smallest interesting diagram. */
function linearIR(): PlaybookIR {
  return playbook({
    id: "linear",
    steps: [
      step({ id: "plan", title: "Plan the work" }),
      step({
        id: "impl",
        title: "Implement",
        needs: ["plan"],
        outcomes: ["success", "changes", "abandon"],
        on: {
          changes: { kind: "goto", target: "plan", maxLoops: 2 },
          abandon: { kind: "end", outcome: "abandoned" },
        },
      }),
      step({
        id: "review",
        title: "Review the diff",
        kind: "gate",
        needs: ["impl"],
        outcomes: ["approved", "rejected"],
        on: { rejected: { kind: "goto", target: "impl", maxLoops: 1 } },
      }),
    ],
  });
}

/** A main graph plus a manual after task, so both subgraph families appear in one diagram. */
function afterIR(): PlaybookIR {
  return playbook({
    id: "afters",
    steps: [
      step({ id: "ship", title: "Ship" }),
      step({
        id: "report",
        title: "Report",
        needs: ["ship"],
        outcomes: ["success", "failure"],
        on: { failure: { kind: "fail" } },
      }),
    ],
    after: [
      {
        id: "cleanup",
        title: "Cleanup",
        trigger: "manual",
        steps: [
          step({ id: "notify", title: "Notify the team" }),
          step({
            id: "verify",
            title: "Verify",
            needs: ["notify"],
            outcomes: ["success", "failure"],
            on: { failure: { kind: "fail" } },
          }),
        ],
      },
    ],
  });
}

/** The kinds fixture: one node per shape, no edges, so the shape table is one assertion. */
function shapesGraph(): PlaybookGraph {
  return buildPlaybookGraph(
    playbook({
      id: "shapes",
      steps: [
        step({ id: "agent", title: "Agent" }),
        step({ id: "script", title: "Script", kind: "script" }),
        step({ id: "delay", title: "Delay", kind: "delay" }),
        step({ id: "gate", title: "Gate", kind: "gate" }),
        step({ id: "branch", title: "Branch", kind: "branch" }),
      ],
    }),
  );
}

/**
 * A main step literally named `block_pr` beside a block id `pr`: two legal IR ids that sanitize to
 * one Mermaid id (`block_pr`), which the subgraph claims before the node (D6, D7).
 */
function blockCollisionIR(): PlaybookIR {
  const base = playbook({
    id: "block-collision",
    steps: [step({ id: "block_pr", title: "Named like the block subgraph" })],
  });
  return {
    ...base,
    steps: [
      ...base.steps,
      step({
        id: "pr_investigate",
        title: "investigate",
        use: { blockId: "pr", playbookId: "child", depth: 1 },
      }),
    ],
    blocks: {
      pr: {
        id: "pr",
        playbookId: "child",
        title: "Child",
        stepIds: ["pr_investigate"],
        entry: ["pr_investigate"],
        terminals: ["pr_investigate"],
        inputs: {},
        outputs: {},
        outcomes: [],
        on: {},
      },
    },
  };
}

/**
 * Two after ids that sanitize to one subgraph id: `after:a-b` and `after:a_b` both become
 * `after_a_b`, so the second subgraph has to take a suffix.
 */
function afterCollisionIR(): PlaybookIR {
  return playbook({
    id: "after-collision",
    steps: [step({ id: "ship", title: "Ship" })],
    after: [
      {
        id: "a-b",
        title: "Dashed",
        trigger: "manual",
        steps: [step({ id: "one", title: "One" })],
      },
      {
        id: "a_b",
        title: "Underscored",
        trigger: "manual",
        steps: [step({ id: "two", title: "Two" })],
      },
    ],
  });
}

describe("escapeMermaidLabel (FR16)", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['"', "#quot;"],
    ["[", "#91;"],
    ["]", "#93;"],
    ["(", "#40;"],
    [")", "#41;"],
    ["{", "#123;"],
    ["}", "#125;"],
    ["|", "#124;"],
    ["#", "#35;"],
    ["<", "#lt;"],
    [">", "#gt;"],
    ["&", "&amp;"],
    ["\n", "<br/>"],
    ["\r", "<br/>"],
    ["`", "'"],
  ];

  it.each(CASES)("escapes %j as %j", (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
  });

  it("flattens a carriage return and a newline alike", () => {
    expect(escapeMermaidLabel("a\rb")).toBe("a<br/>b");
    expect(escapeMermaidLabel("a\nb")).toBe("a<br/>b");
    expect(escapeMermaidLabel("a\r\nb")).toBe("a<br/><br/>b");
  });

  it("leaves ordinary prose and unicode untouched", () => {
    expect(escapeMermaidLabel("Plan the work")).toBe("Plan the work");
    expect(escapeMermaidLabel("Déployer · 出荷")).toBe("Déployer · 出荷");
    expect(escapeMermaidLabel("")).toBe("");
  });

  it("escapes a hostile title without breaking the quoted slot", () => {
    expect(escapeMermaidLabel('Say "hi" [now]')).toBe("Say #quot;hi#quot; #91;now#93;");
  });

  it("cuts at 60 characters with an ellipsis, counting characters not bytes", () => {
    expect(escapeMermaidLabel("a".repeat(60))).toBe("a".repeat(60));
    expect(escapeMermaidLabel("a".repeat(61))).toBe(`${"a".repeat(60)}…`);
    // One emoji is one character even though it is four bytes.
    expect(escapeMermaidLabel("🚀".repeat(61))).toBe(`${"🚀".repeat(60)}…`);
  });

  it("cuts before escaping, so the ellipsis is never split by an entity", () => {
    expect(escapeMermaidLabel("[".repeat(61))).toBe(`${"#91;".repeat(60)}…`);
  });
});

describe("mermaidNodeKey (FR14, D6, D7)", () => {
  it("sanitizes to [A-Za-z0-9_] and prefixes a digit-leading id", () => {
    expect(mermaidNodeKey("design", new Set())).toBe("design");
    expect(mermaidNodeKey("after:cleanup/notify", new Set())).toBe("after_cleanup_notify");
    expect(mermaidNodeKey("2fast", new Set())).toBe("n_2fast");
    // An id with no safe character still yields a key: one `_` per replaced character, else `node`.
    expect(mermaidNodeKey("日本語", new Set())).toBe("___");
    expect(mermaidNodeKey("", new Set())).toBe("node");
  });

  it("suffixes on collision in the order the keys are handed out", () => {
    const taken = new Set<string>();
    expect(mermaidNodeKey("a-b", taken)).toBe("a_b");
    expect(mermaidNodeKey("a_b", taken)).toBe("a_b_2");
    expect(mermaidNodeKey("a_b", taken)).toBe("a_b_3");
  });

  it("gives @end the bare end_node key and suffixes a step that wanted it", () => {
    const taken = new Set<string>();
    expect(mermaidNodeKey("@end", taken)).toBe("end_node");
    expect(mermaidNodeKey("end_node", taken)).toBe("end_node_2");
  });

  it("reserves end_node even though the synthetic node is drawn last", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "collision",
        steps: [
          step({
            id: "end_node",
            title: "Named like the synthetic key",
            outcomes: ["success", "stop"],
            on: { stop: { kind: "end" } },
          }),
        ],
      }),
    );
    const lines = renderMermaid(graph).split("\n");

    expect(lines).toContain('  end_node_2["Named like the synthetic key"]');
    expect(lines).toContain('  end_node(["end"])');
  });
});

describe("renderMermaid (FR13–FR16)", () => {
  it("renders one node per kind with its FR14 shape", () => {
    expect(renderMermaid(shapesGraph())).toBe(
      [
        "flowchart LR",
        '  agent["Agent"]',
        '  script[["Script"]]',
        '  delay(["Delay"])',
        '  gate{{"Gate"}}',
        '  branch{"Branch"}',
        "",
      ].join("\n"),
    );
  });

  it("changes only the header for --direction TB (D5)", () => {
    const graph = shapesGraph();
    const lr = renderMermaid(graph).split("\n");
    const tb = renderMermaid(graph, { direction: "TB" }).split("\n");

    expect(lr[0]).toBe("flowchart LR");
    expect(tb[0]).toBe("flowchart TB");
    expect(tb.slice(1)).toStrictEqual(lr.slice(1));
  });

  it("carries the playbook identity as a comment when one is passed", () => {
    const lines = renderMermaid(shapesGraph(), {
      identity: { id: "plan", hash: "3f2a" },
    }).split("\n");

    expect(lines[1]).toBe("  %% argos playbook plan (hash 3f2a)");
    expect(renderMermaid(shapesGraph())).not.toContain("%% argos playbook");
  });

  it("uses FR15 syntax per edge kind, a loop dashed with its max_loops", () => {
    const lines = renderMermaid(buildPlaybookGraph(linearIR())).split("\n");

    expect(lines).toContain("  plan --> impl");
    expect(lines).toContain("  impl --> review");
    expect(lines).toContain("  impl -.->|changes · max_loops=2| plan");
    expect(lines).toContain("  impl -->|abandoned| end_node");
    expect(lines).toContain("  review -.->|rejected · max_loops=1| impl");
  });

  it("draws ask thick, a branch case dashed, and a loop without max_loops dashed", () => {
    const graph = buildPlaybookGraph(
      playbook({
        id: "arrows",
        steps: [
          step({ id: "start" }),
          step({
            id: "route",
            kind: "branch",
            needs: ["start"],
            branch: {
              cases: [
                { name: "service", when: { "steps.start.outcome": "success" }, end: true },
                { name: "other" },
              ],
            },
          }),
          step({
            id: "ask",
            needs: ["route"],
            outcomes: ["check", "retry"],
            on: {
              check: { kind: "ask", ask: "Ship it?", target: "ship" },
              retry: { kind: "goto", target: "route" },
            },
          }),
          step({ id: "ship", needs: ["ask"] }),
        ],
      }),
    );
    const lines = renderMermaid(graph).split("\n");

    expect(lines).toContain("  ask ==>|check| ship");
    expect(lines).toContain("  route -.->|service| end_node");
    expect(lines).toContain("  ask -.->|retry| route");
    expect(lines).toContain("  start --> route");
  });

  it("wraps a sub-playbook block and an after task in one subgraph each", () => {
    const sub = renderMermaid(buildPlaybookGraph(loadPlaybook(SUBPLAYBOOK, "parent"))).split("\n");
    expect(sub).toContain('  subgraph block_pr["pr"]');
    expect(sub).toContain('    pr_investigate["investigate"]');
    expect(sub).toContain("  end");

    const after = renderMermaid(buildPlaybookGraph(afterIR())).split("\n");
    expect(after).toContain('  subgraph after_cleanup["after cleanup"]');
    expect(after).toContain('    after_cleanup_notify["Notify the team"]');
    expect(after).toContain('  end_node(["end"])');
  });

  it("emits no classDef and no tones comment without statuses (D4)", () => {
    const text = renderMermaid(buildPlaybookGraph(linearIR()));

    expect(text).not.toContain("classDef");
    expect(text).not.toContain("%% tones:");
    expect(text).not.toContain("subgraph legend");
  });

  it("emits one classDef per tone that appears plus one class per decorated node (FR16)", () => {
    const text = renderMermaid(buildPlaybookGraph(linearIR()), {
      statuses: [
        { id: "plan", tone: "success" },
        { id: "impl", tone: "accent" },
        { id: "@end", tone: "mystery" },
        { id: "ghost", tone: "danger" },
      ],
    });
    const lines = text.split("\n");

    expect(lines).toContain("  %% tones: ok, info, neutral");
    expect(lines).toContain("  classDef ok fill:#e7f8ec,stroke:#1a7f37");
    expect(lines).toContain("  classDef info fill:#e8f0fe,stroke:#0969da");
    expect(lines).toContain("  classDef neutral fill:#f6f8fa,stroke:#57606a");
    // Declaration order follows TONE_ORDER, not the caller's list.
    expect(lines.indexOf("  classDef ok fill:#e7f8ec,stroke:#1a7f37")).toBeLessThan(
      lines.indexOf("  classDef info fill:#e8f0fe,stroke:#0969da"),
    );
    expect(lines).toContain("  class plan ok");
    expect(lines).toContain("  class impl info");
    expect(lines).toContain("  class end_node neutral");
    // An id the graph does not carry decorates nothing.
    expect(text).not.toContain("ghost");
    expect(text).not.toContain("class review");
  });

  it("keeps a hostile title inside its quoted slot and flattens a newline", () => {
    const graph = buildPlaybookGraph(
      playbook({ id: "hostile", steps: [step({ id: "a", title: 'x" --> b["y\nz' })] }),
    );

    const line = renderMermaid(graph).split("\n").find((item) => item.startsWith("  a["));
    expect(line).toBe('  a["x#quot; --#gt; b#91;#quot;y<br/>z"]');
  });

  it("is deterministic and ends with a newline", () => {
    const graph = buildPlaybookGraph(linearIR());
    const options = { statuses: [{ id: "plan", tone: "success" }] };

    expect(renderMermaid(graph, options)).toBe(renderMermaid(graph, options));
    expect(renderMermaid(graph, options).endsWith("\n")).toBe(true);
  });
});

describe("renderMermaid id namespace (FR14, D6, D7)", () => {
  it("gives a subgraph its id before a same-named step can take it", () => {
    const lines = renderMermaid(buildPlaybookGraph(blockCollisionIR())).split("\n");

    expect(lines).toStrictEqual([
      "flowchart LR",
      '  block_pr_2["Named like the block subgraph"]',
      '  subgraph block_pr["pr"]',
      '    pr_investigate["investigate"]',
      "  end",
      "",
    ]);
  });

  it("suffixes a second subgraph that sanitizes to the same id", () => {
    const lines = renderMermaid(buildPlaybookGraph(afterCollisionIR())).split("\n");
    const subgraphs = lines
      .filter((line) => line.startsWith("  subgraph "))
      .map((line) => line.slice("  subgraph ".length).split("[")[0]);

    expect(subgraphs).toStrictEqual(["after_a_b", "after_a_b_2"]);
    expect(lines).toContain('  subgraph after_a_b["after a-b"]');
    expect(lines).toContain('  subgraph after_a_b_2["after a_b"]');
    expect(lines).toContain('    after_a_b_one["One"]');
    expect(lines).toContain('    after_a_b_two["Two"]');
  });

  it("is byte-identical on a second render of a colliding graph", () => {
    const graphs = [
      buildPlaybookGraph(blockCollisionIR()),
      buildPlaybookGraph(afterCollisionIR()),
    ];

    for (const graph of graphs) {
      expect(renderMermaid(graph)).toBe(renderMermaid(graph));
    }
  });
});

describe("decorateGraph (FR16)", () => {
  it("joins status and tone by id and leaves an unknown id untouched", () => {
    const graph = buildPlaybookGraph(linearIR());
    const decorated = decorateGraph(graph, [
      { id: "plan", status: "completed", tone: "success" },
      { id: "ghost", status: "failed", tone: "danger" },
    ]);

    expect(decorated.nodes[0]).toStrictEqual({
      id: "plan",
      title: "Plan the work",
      kind: "agent",
      status: "completed",
      tone: "success",
    });
    expect(decorated.nodes[1]).toStrictEqual({ id: "impl", title: "Implement", kind: "agent" });
    expect(decorated.nodes[1]).not.toHaveProperty("tone");
    expect(decorated.entry).toStrictEqual(graph.entry);
    expect(decorated.terminals).toStrictEqual(graph.terminals);
    expect(decorated.edges).toStrictEqual(graph.edges);
  });

  it("never mutates the input graph", () => {
    const graph = buildPlaybookGraph(linearIR());
    const before = JSON.stringify(graph);

    decorateGraph(graph, [{ id: "plan", status: "running", tone: "accent" }]);

    expect(JSON.stringify(graph)).toStrictEqual(before);
    expect(graph.nodes[0]).not.toHaveProperty("status");
  });
});

describe("mermaid goldens", () => {
  it("renders a linear playbook with a loop and an end", () => {
    expectGolden("linear.mmd", renderMermaid(buildPlaybookGraph(linearIR())));
  });

  it("renders a sub-playbook block from the repository fixture", () => {
    const ir = loadPlaybook(SUBPLAYBOOK, "parent");

    expectGolden(
      "subplaybook.mmd",
      renderMermaid(buildPlaybookGraph(ir), { identity: { id: ir.id, hash: ir.hash } }),
    );
  });

  it("renders an after task beside the main graph", () => {
    expectGolden("after.mmd", renderMermaid(buildPlaybookGraph(afterIR())));
  });
});

describe("layerGraph (FR19)", () => {
  /** A straight chain of `count` agent steps, the pathological wide graph. */
  function chainGraph(count: number): PlaybookGraph {
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      title: `Step ${index}`,
      kind: "agent" as const,
    }));
    const edges = Array.from({ length: count - 1 }, (_, index) => ({
      from: `s${index}`,
      to: `s${index + 1}`,
      kind: "needs" as const,
    }));
    return {
      nodes,
      edges,
      entry: count === 0 ? [] : ["s0"],
      terminals: count === 0 ? [] : [`s${count - 1}`],
    };
  }

  const box = (node: LayoutNode): string => `${node.id}@${node.x},${node.y}`;

  /** Two boxes overlap only if they overlap on both axes. */
  function overlap(a: LayoutNode, b: LayoutNode): boolean {
    return (
      a.x < b.x + b.width &&
      b.x < a.x + a.width &&
      a.y < b.y + b.height &&
      b.y < a.y + a.height
    );
  }

  /** The four coordinate pairs of a `M x y C c1x c1y c2x c2y x y` path. */
  function pathPoints(
    path: string,
  ):
    | {
        readonly start: readonly [number, number];
        readonly c1: readonly [number, number];
        readonly c2: readonly [number, number];
        readonly end: readonly [number, number];
      }
    | null {
    const match = /^M (-?\d+) (-?\d+) C (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/.exec(
      path,
    );
    if (match === null) return null;
    const numbers = match.slice(1).map(Number);
    const pair = (index: number): readonly [number, number] => [
      numbers[index] ?? 0,
      numbers[index + 1] ?? 0,
    ];
    return { start: pair(0), c1: pair(2), c2: pair(4), end: pair(6) };
  }

  it("places one node at the padding origin and sizes the viewBox around it", () => {
    const layout = layerGraph({
      nodes: [{ id: "only", title: "Only", kind: "agent" }],
      edges: [],
      entry: ["only"],
      terminals: ["only"],
    });

    expect(layout.nodes).toStrictEqual([
      { id: "only", x: 16, y: 16, width: 180, height: 48, layer: 0 },
    ]);
    expect(layout.edges).toStrictEqual([]);
    expect(layout.width).toBe(16 + 180 + 16);
    expect(layout.height).toBe(16 + 48 + 16);
    expect(layout.viewBox).toBe(`0 0 ${layout.width} ${layout.height}`);
  });

  it("lays a diamond out by longest path, in graph.nodes order within a layer", () => {
    const layout = layerGraph({
      nodes: [
        { id: "start", title: "Start", kind: "agent" },
        { id: "left", title: "Left", kind: "agent" },
        { id: "right", title: "Right", kind: "agent" },
        { id: "join", title: "Join", kind: "agent" },
      ],
      edges: [
        { from: "start", to: "left", kind: "needs" },
        { from: "start", to: "right", kind: "needs" },
        { from: "left", to: "join", kind: "needs" },
        { from: "right", to: "join", kind: "needs" },
      ],
      entry: ["start"],
      terminals: ["join"],
    });

    expect(layout.nodes.map(box)).toStrictEqual([
      "start@16,16",
      "left@260,16",
      "right@260,88",
      "join@504,16",
    ]);
    expect(layout.nodes.map((node) => node.layer)).toStrictEqual([0, 1, 1, 2]);
  });

  it("never overlaps two boxes and keeps the padding margins", () => {
    const graphs = [
      buildPlaybookGraph(linearIR()),
      buildPlaybookGraph(afterIR()),
      buildPlaybookGraph(loadPlaybook(SUBPLAYBOOK, "parent")),
      chainGraph(61),
    ];

    for (const graph of graphs) {
      const layout = layerGraph(graph);
      expect(layout.nodes).toHaveLength(graph.nodes.length);
      for (let i = 0; i < layout.nodes.length; i += 1) {
        const node = layout.nodes[i];
        if (node === undefined) continue;
        expect(node.x).toBeGreaterThanOrEqual(16);
        expect(node.y).toBeGreaterThanOrEqual(16);
        expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
        expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          const other = layout.nodes[j];
          if (other === undefined) continue;
          expect(overlap(node, other)).toBe(false);
        }
      }
    }
  });

  it("ranks every needs edge strictly left to right", () => {
    const graph = buildPlaybookGraph(linearIR());
    const layout = layerGraph(graph);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    const needs = graph.edges.filter((edge) => edge.kind === "needs");
    expect(needs.length).toBeGreaterThan(0);
    for (const edge of needs) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      if (from === undefined || to === undefined) continue;
      expect(to.layer).toBeGreaterThan(from.layer);
      expect(to.x).toBeGreaterThan(from.x);
    }
  });

  it("routes a loop edge below every box, with its label at the midpoint", () => {
    const layout = layerGraph(buildPlaybookGraph(linearIR()));
    const loop = layout.edges.find((edge) => edge.loop);
    expect(loop).toBeDefined();
    if (loop === undefined) return;
    const points = pathPoints(loop.path);
    expect(points).not.toBeNull();
    if (points === null) return;
    const { start, c1, c2, end } = points;
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const from = byId.get(loop.from);
    const to = byId.get(loop.to);
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    if (from === undefined || to === undefined) return;
    // Below every box the loop passes under (the layers it spans), and below all of them.
    const spanned = layout.nodes.filter(
      (node) => node.layer >= Math.min(from.layer, to.layer) && node.layer <= Math.max(from.layer, to.layer),
    );
    const spannedBottom = Math.max(...spanned.map((node) => node.y + node.height));
    const bottom = Math.max(...layout.nodes.map((node) => node.y + node.height));
    expect(start[1]).toBeLessThan(spannedBottom);
    expect(end[1]).toBeLessThan(spannedBottom);
    expect(c1[1]).toBeGreaterThan(bottom);
    expect(c2[1]).toBeGreaterThan(bottom);
    expect(loop.labelY).toBeGreaterThan(spannedBottom);
  });

  it("gives an adjacent edge straight control points and a skip a ±12 px bend", () => {
    const layout = layerGraph({
      nodes: [
        { id: "a", title: "A", kind: "agent" },
        { id: "b", title: "B", kind: "agent" },
        { id: "c", title: "C", kind: "agent" },
      ],
      edges: [
        { from: "a", to: "b", kind: "needs" },
        { from: "b", to: "c", kind: "needs" },
        { from: "a", to: "c", kind: "needs" },
      ],
      entry: ["a"],
      terminals: ["c"],
    });
    const byKind = new Map(layout.edges.map((edge) => [edge.to, edge]));
    const adjacent = pathPoints(byKind.get("b")?.path ?? "");
    const skip = pathPoints(byKind.get("c")?.path ?? "");
    expect(adjacent).not.toBeNull();
    expect(skip).not.toBeNull();
    if (adjacent === null || skip === null) return;

    // Adjacent: the control points keep the anchors' y, so the curve is a straight horizontal line.
    expect(adjacent.c1[1]).toBe(adjacent.start[1]);
    expect(adjacent.c2[1]).toBe(adjacent.end[1]);
    // Skip: both control points move by the same ±12 px.
    expect(Math.abs(skip.c1[1] - skip.start[1])).toBe(12);
    expect(Math.abs(skip.c2[1] - skip.end[1])).toBe(12);
    expect(skip.c1[1] - skip.start[1]).toBe(skip.c2[1] - skip.end[1]);
  });

  it("is pure: the same graph yields a deep-equal layout", () => {
    const graphs = [
      buildPlaybookGraph(linearIR()),
      buildPlaybookGraph(afterIR()),
      chainGraph(61),
    ];
    for (const graph of graphs) {
      expect(layerGraph(graph)).toStrictEqual(layerGraph(graph));
    }
  });

  it("normalizes the top-left to (16, 16) and keeps the viewBox consistent", () => {
    for (const graph of [buildPlaybookGraph(linearIR()), chainGraph(61)]) {
      const layout: GraphLayout = layerGraph(graph);
      const left = Math.min(...layout.nodes.map((node) => node.x));
      const top = Math.min(...layout.nodes.map((node) => node.y));
      // A backward edge's control point may reach further left than its target box, and the whole
      // drawing is kept inside the padding; no box ever starts above/left of it.
      expect(left).toBeGreaterThanOrEqual(16);
      expect(top).toBeGreaterThanOrEqual(16);
      if (graph.edges.every((edge) => edge.loop !== true)) {
        expect(left).toBe(16);
        expect(top).toBe(16);
      }
      expect(layout.viewBox).toBe(`0 0 ${layout.width} ${layout.height}`);
      expect(Number.isInteger(layout.width)).toBe(true);
      expect(Number.isInteger(layout.height)).toBe(true);
      for (const node of layout.nodes) {
        expect(Number.isInteger(node.x)).toBe(true);
        expect(Number.isInteger(node.y)).toBe(true);
      }
    }
  });
});
