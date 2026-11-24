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
  mermaidNodeKey,
  renderMermaid,
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
    ["`", "'"],
  ];

  it.each(CASES)("escapes %j as %j", (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
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
