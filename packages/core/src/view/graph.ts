/**
 * The Mermaid renderer for the playbook graph (FR13–FR16): one pure function from the projected
 * `PlaybookGraph` to a string GitHub/GitLab can draw, plus the two helpers a golden test and a
 * committed `.mmd` both depend on — label escaping and node keys.
 *
 * The decisions this module is built on:
 *
 * - **Pure strings.** No DOM, no `zod`, no `node:*`, and never `../playbook/graph.js`: the web
 *   bundle imports this module, and importing the projector would drag the loader into the browser
 *   (`test/view/purity.test.ts`). The graph arrives already projected.
 * - **Node keys are the sanitized IR step id, never an index** (D6). `n0, n1, …` would rewrite
 *   every key in every committed diagram the moment a step is inserted; an id-keyed diagram diffs
 *   line by line.
 * - **One synthetic `@end` node, keyed `end_node`** (D7). The synthetic node owns the bare key, so a
 *   step literally named `end_node` becomes `end_node_2` — pinned by a test.
 * - **No legend subgraph** (D4). A `subgraph legend` doubles the node count of a small diagram and
 *   is the first thing to drift; one `classDef` per tone that appears plus a `%% tones:` comment
 *   says the same thing without changing the shape.
 * - **Nothing private leaks.** Labels come from `title` and edge `label` only, both free text the
 *   read model already publishes; escaping keeps a hostile title from breaking the diagram instead
 *   of hiding it.
 *
 * The output is deterministic: the same graph and the same options produce a byte-identical
 * string, because both the node lines and the edge lines follow `graph.nodes` / `graph.edges` order
 * and the tone classes follow a fixed table order.
 *
 * `layerGraph` (the web DAG view, FR19) lives here too, and for the same reason: the layout is pure
 * arithmetic over the projected graph — no DOM, no measurement, no randomness — so the same graph
 * always produces the same geometry and the browser can render it on every poll without a diff.
 */

import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  PlaybookGraph,
} from "../rpc/contracts.js";

/** The synthetic end node's id (FR4), which is not a legal IR step id. */
const END_NODE_ID = "@end";
/** The one key the synthetic end node owns (D7). */
const END_NODE_KEY = "end_node";
/** Prefix of an after-task group; the rest is the `after` id. */
const AFTER_GROUP_PREFIX = "after:";
/** Titles are cut here before escaping, counted in characters (FR16). */
const LABEL_LIMIT = 60;

/** Reading direction of the diagram (FR13, D5): `LR` is the default, `TB` fits tall playbooks. */
export type MermaidDirection = "LR" | "TB";

/** The five tone classes a decorated node can land in. */
export type GraphTone = "ok" | "warn" | "err" | "info" | "neutral";

/** The playbook a diagram describes, so a committed `.mmd` is self-describing (FR13). */
export interface GraphIdentity {
  readonly id: string;
  readonly hash: string;
}

/** One node's tone for `--run`: an id plus the tone its status already resolved to. */
export interface GraphStatus {
  readonly id: string;
  readonly tone: string;
}

/** One node's full decoration, the shape `decorateGraph` joins on. */
export interface NodeDecoration extends GraphStatus {
  readonly status: string;
}

/** `renderMermaid` options: direction, the identity comment, and per-node tones. */
export interface MermaidOptions {
  readonly direction?: MermaidDirection;
  readonly identity?: GraphIdentity;
  readonly statuses?: readonly GraphStatus[];
}

/** A graph node carrying the status/tone `--run` decorated it with. */
export interface DecoratedNode extends GraphNode {
  readonly status?: string;
  readonly tone?: string;
}

/**
 * A graph decorated with run statuses. The contract has no status key on purpose (a graph is
 * structural; a status belongs to a run), so the decorated shape lives here.
 */
export interface DecoratedGraph {
  nodes: DecoratedNode[];
  edges: GraphEdge[];
  entry: string[];
  terminals: string[];
}

/** Per-character escapes (FR16). One pass over the input; replacements are never re-scanned. */
const ESCAPES: Readonly<Record<string, string>> = {
  '"': "#quot;",
  "[": "#91;",
  "]": "#93;",
  "(": "#40;",
  ")": "#41;",
  "{": "#123;",
  "}": "#125;",
  "|": "#124;",
  "#": "#35;",
  "<": "#lt;",
  ">": "#gt;",
  "&": "&amp;",
  "\n": "<br/>",
  "`": "'",
};

/** FR14: one shape per node kind. `end` reuses the delay/terminal shape the spec pins. */
const NODE_SHAPES: Readonly<Record<GraphNodeKind, (label: string) => string>> = {
  agent: (label) => `["${label}"]`,
  script: (label) => `[["${label}"]]`,
  delay: (label) => `(["${label}"])`,
  gate: (label) => `{{"${label}"}}`,
  branch: (label) => `{"${label}"}`,
  end: (label) => `(["${label}"])`,
};

/** Fixed emission order of the tone classes, so two runs never disagree (FR16). */
const TONE_ORDER: readonly GraphTone[] = ["ok", "warn", "err", "info", "neutral"];

/** The classDef body per tone: plain CSS colours, no emoji and no colour in the label (FR16). */
const TONE_STYLES: Readonly<Record<GraphTone, string>> = {
  ok: "fill:#e7f8ec,stroke:#1a7f37",
  warn: "fill:#fff8e5,stroke:#9a6700",
  err: "fill:#fdecec,stroke:#cf222e",
  info: "fill:#e8f0fe,stroke:#0969da",
  neutral: "fill:#f6f8fa,stroke:#57606a",
};

/** The read model's tone vocabulary *and* the class names, so a caller may pass either. */
const TONE_ALIASES: Readonly<Record<string, GraphTone>> = {
  ok: "ok",
  success: "ok",
  warn: "warn",
  warning: "warn",
  err: "err",
  danger: "err",
  info: "info",
  accent: "info",
  neutral: "neutral",
};

/**
 * Escape one label for a Mermaid `"…"` / `|…|` slot (FR16). The title is cut to 60 characters
 * first — counted in code points, so a surrogate pair is one character — and escaped afterwards, so
 * the ellipsis is never split. A character with no entry passes through unchanged.
 */
export function escapeMermaidLabel(text: string): string {
  const characters = Array.from(text);
  const cut =
    characters.length > LABEL_LIMIT ? `${characters.slice(0, LABEL_LIMIT).join("")}…` : text;
  let escaped = "";
  for (const character of cut) escaped += ESCAPES[character] ?? character;
  return escaped;
}

/** A Mermaid-safe base key: `[A-Za-z0-9_]`, never empty, never starting with a digit (FR14). */
function baseKey(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_]/g, "_");
  if (sanitized === "") return "node";
  return /^[0-9]/.test(sanitized) ? `n_${sanitized}` : sanitized;
}

/**
 * A stable node key (FR14, D6, D7): the IR step id sanitized to `[A-Za-z0-9_]`, prefixed `n_` when
 * it starts with a digit, suffixed `_2`, `_3`… on collision in IR order. `@end` always takes
 * `end_node`; a step that sanitizes to the same key was seen first and therefore keeps a suffix.
 *
 * The `taken` set is the caller's, in the order the keys are handed out: a graph-wide pass over
 * `graph.nodes` is what makes the assignment deterministic.
 */
export function mermaidNodeKey(id: string, taken: Set<string>): string {
  if (id === END_NODE_ID) {
    // The synthetic end node owns the bare key even when it is drawn last (D7).
    taken.add(END_NODE_KEY);
    return END_NODE_KEY;
  }
  const base = baseKey(id);
  let key = base;
  for (let suffix = 2; taken.has(key); suffix += 1) key = `${base}_${suffix}`;
  taken.add(key);
  return key;
}

/** The tone class a caller's tone name lands in; an unknown tone is `neutral`, never undefined. */
function toneClass(tone: string): GraphTone {
  return TONE_ALIASES[tone] ?? "neutral";
}

/** `after:cleanup` → `after_cleanup`, a block id `pr` → `block_pr` (FR15). */
function groupKey(group: string): string {
  if (group.startsWith(AFTER_GROUP_PREFIX)) {
    return baseKey(`after_${group.slice(AFTER_GROUP_PREFIX.length)}`);
  }
  return baseKey(`block_${group}`);
}

/** The label inside a `subgraph …["…"]` header: the after id, else the block id (D6 has no title). */
function groupLabel(group: string): string {
  if (group.startsWith(AFTER_GROUP_PREFIX)) {
    return `after ${group.slice(AFTER_GROUP_PREFIX.length)}`;
  }
  return group;
}

/** One node line, `key["title"]` (FR14). */
function nodeLine(node: GraphNode, key: string, indent: string): string {
  return `${indent}${key}${NODE_SHAPES[node.kind](escapeMermaidLabel(node.title))}`;
}

/** The `|label|` part of an edge, with the loop allowance appended (FR15). */
function edgeLabel(edge: GraphEdge): string | undefined {
  if (edge.label === undefined) return undefined;
  const loop = edge.loop === true && edge.maxLoops !== undefined;
  const allowance = loop ? ` · max_loops=${edge.maxLoops}` : "";
  return `${escapeMermaidLabel(edge.label)}${allowance}`;
}

/** One edge line (FR15): `needs` solid, jumps dashed, `ask` thick, and a loop always dashed. */
function edgeLine(edge: GraphEdge, keys: ReadonlyMap<string, string>): string {
  const from = keys.get(edge.from) ?? baseKey(edge.from);
  const to = keys.get(edge.to) ?? baseKey(edge.to);
  const dashed = edge.kind === "goto" || edge.kind === "branch" || edge.loop === true;
  const arrow = dashed ? "-.->" : edge.kind === "ask" ? "==>" : "-->";
  const label = edgeLabel(edge);
  return `${from} ${arrow}${label === undefined ? "" : `|${label}|`} ${to}`;
}

/**
 * Decorate a graph with the statuses of one run (FR16, `argos chart --run`). A pure join by node id,
 * one pass, no mutation of the input: an id the graph does not carry is ignored, so after-task nodes
 * stay neutral. The tone is kept verbatim — `renderMermaid` maps it to a class.
 */
export function decorateGraph(
  graph: PlaybookGraph,
  steps: readonly NodeDecoration[],
): DecoratedGraph {
  const byId = new Map<string, NodeDecoration>();
  for (const item of steps) byId.set(item.id, item);
  return {
    nodes: graph.nodes.map((node) => {
      const hit = byId.get(node.id);
      return hit === undefined
        ? { ...node }
        : { ...node, status: hit.status, tone: hit.tone };
    }),
    edges: graph.edges.map((edge) => ({ ...edge })),
    entry: [...graph.entry],
    terminals: [...graph.terminals],
  };
}

/**
 * Render a projected graph as Mermaid text (FR13–FR16). Default `flowchart LR`; the identity
 * comment carries the playbook id and hash; nodes and edges keep the graph's own order; grouped
 * nodes are wrapped in one `subgraph` per group; and a decorated graph ends with one `classDef` per
 * tone that appears plus one `class` line per decorated node. The result always ends with a newline.
 */
export function renderMermaid(graph: PlaybookGraph, options: MermaidOptions = {}): string {
  const direction = options.direction ?? "LR";
  const keys = new Map<string, string>();
  const taken = new Set<string>();
  // Reserve the synthetic key first so a step that sanitizes to `end_node` cannot take it (D7).
  if (graph.nodes.some((node) => node.id === END_NODE_ID)) taken.add(END_NODE_KEY);
  for (const node of graph.nodes) keys.set(node.id, mermaidNodeKey(node.id, taken));

  const toneByNode = new Map<string, GraphTone>();
  const wanted = new Map<string, GraphTone>();
  for (const status of options.statuses ?? []) wanted.set(status.id, toneClass(status.tone));
  for (const node of graph.nodes) {
    const tone = wanted.get(node.id);
    if (tone !== undefined) toneByNode.set(node.id, tone);
  }
  const tones = TONE_ORDER.filter((tone) => [...toneByNode.values()].includes(tone));

  const lines: string[] = [`flowchart ${direction}`];
  if (options.identity !== undefined) {
    lines.push(`  %% argos playbook ${options.identity.id} (hash ${options.identity.hash})`);
  }
  if (tones.length > 0) lines.push(`  %% tones: ${tones.join(", ")}`);

  const grouped = new Set<string>();
  for (const node of graph.nodes) {
    const key = keys.get(node.id) ?? baseKey(node.id);
    if (node.group === undefined) {
      lines.push(nodeLine(node, key, "  "));
      continue;
    }
    // A group's nodes are emitted together, at the position of its first node (D4: no legend).
    if (grouped.has(node.group)) continue;
    grouped.add(node.group);
    lines.push(
      `  subgraph ${groupKey(node.group)}["${escapeMermaidLabel(groupLabel(node.group))}"]`,
    );
    for (const member of graph.nodes) {
      if (member.group !== node.group) continue;
      lines.push(nodeLine(member, keys.get(member.id) ?? baseKey(member.id), "    "));
    }
    lines.push("  end");
  }

  for (const edge of graph.edges) lines.push(`  ${edgeLine(edge, keys)}`);

  if (tones.length > 0) {
    for (const tone of tones) lines.push(`  classDef ${tone} ${TONE_STYLES[tone]}`);
    for (const node of graph.nodes) {
      const tone = toneByNode.get(node.id);
      if (tone === undefined) continue;
      lines.push(`  class ${keys.get(node.id) ?? baseKey(node.id)} ${tone}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ web layout (FR19)

/** The fixed node box the web view draws (FR19): 180×48 layout units. */
const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;
/** Horizontal gap between layers, and the vertical gap between two nodes of one layer. */
const LAYER_GAP = 64;
const ROW_GAP = 24;
/** The layout's margin: every graph starts at `(16, 16)` (FR19). */
const LAYOUT_PADDING = 16;
/** Vertical offset of the control points of an edge spanning non-adjacent layers (FR19). */
const SKIP_BEND = 12;
/** How far below the lowest box a loop edge is routed (FR19). */
const LOOP_DROP = 24;
/** Horizontal distance of each Bézier control point from its anchor. */
const CONTROL_REACH = 32;

/** Optional geometry overrides; the defaults are the spec's numbers (FR19). */
export interface GraphLayoutOptions {
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
  readonly layerGap?: number;
  readonly rowGap?: number;
  readonly padding?: number;
}

/** One placed box. Coordinates are integers in the layout's own space, top-left at `(16, 16)`. */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

/** One routed edge: a cubic Bézier between box anchors plus the midpoint its label sits on. */
export interface LayoutEdge {
  from: string;
  to: string;
  path: string;
  kind: GraphEdgeKind;
  loop: boolean;
  label?: string;
  labelX: number;
  labelY: number;
}

/** The whole drawing: node boxes, edge paths, and the `viewBox` an `<svg>` needs (FR19). */
export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  viewBox: string;
}

/** A point in layout space, used only to take the bounds before the padding is applied. */
interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Longest-path layering over the non-loop edges (FR19): `rank(n) = 1 + max(rank(dep))` for every
 * inbound edge that is not a loop, so a node with no such inbound edge is layer 0. `needs` forms a
 * DAG by construction (`playbook_cycle`), and an unmarked jump only moves forward, so the result is
 * also the projector's `needs` ranking extended by the forward jumps. The `visiting` guard mirrors
 * the projector's: a hand-built graph that does contain a cycle stops recursing instead of hanging.
 */
function rankNodes(graph: PlaybookGraph): Map<string, number> {
  const known = new Set<string>();
  const preds = new Map<string, string[]>();
  for (const node of graph.nodes) {
    known.add(node.id);
    preds.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (edge.loop === true) continue;
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    preds.get(edge.to)?.push(edge.from);
  }

  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const pred of preds.get(id) ?? []) value = Math.max(value, rankOf(pred) + 1);
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  for (const node of graph.nodes) rankOf(node.id);
  return rank;
}

/** The cubic Bézier `d` attribute (FR19), one `M` and one `C`, coordinates already rounded. */
function bezierPath(
  start: LayoutPoint,
  c1: LayoutPoint,
  c2: LayoutPoint,
  end: LayoutPoint,
): string {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;
}

/** The curve's midpoint (t = 0.5), where an edge's label sits (FR19). */
function midpoint(
  start: LayoutPoint,
  c1: LayoutPoint,
  c2: LayoutPoint,
  end: LayoutPoint,
): LayoutPoint {
  return {
    x: Math.round((start.x + 3 * c1.x + 3 * c2.x + end.x) / 8),
    y: Math.round((start.y + 3 * c1.y + 3 * c2.y + end.y) / 8),
  };
}

/** Grow a bounds accumulator with one point. */
function include(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  point: LayoutPoint,
): void {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

/**
 * Place the projected graph on a fixed grid for the web DAG view (FR19).
 *
 * Longest-path layering over the non-loop edges, one column per layer with `graph.nodes` order
 * deciding the row, 180×48 boxes, cubic Bézier edges between box anchors (a loop dips below every
 * box, a skip bends by ±12 px), and the whole drawing normalized so its top-left is `(16, 16)`.
 * Pure arithmetic: the same graph always yields a deep-equal layout, which is what lets the run page
 * re-render on every poll without a layout library or a measurement pass.
 */
export function layerGraph(
  graph: PlaybookGraph,
  options: GraphLayoutOptions = {},
): GraphLayout {
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT;
  const layerGap = options.layerGap ?? LAYER_GAP;
  const rowGap = options.rowGap ?? ROW_GAP;
  const padding = options.padding ?? LAYOUT_PADDING;

  const rank = rankNodes(graph);
  if (graph.nodes.length === 0) {
    const empty = Math.round(padding * 2);
    return { nodes: [], edges: [], width: empty, height: empty, viewBox: `0 0 ${empty} ${empty}` };
  }
  const rows = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const layer = rank.get(node.id) ?? 0;
    const row = rows.get(layer);
    if (row === undefined) rows.set(layer, [node.id]);
    else row.push(node.id);
  }

  const boxes = new Map<string, LayoutNode>();
  for (const [layer, ids] of rows) {
    ids.forEach((id, row) => {
      boxes.set(id, {
        id,
        x: layer * (nodeWidth + layerGap),
        y: row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
        layer,
      });
    });
  }

  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  let lowest = 0;
  for (const box of boxes.values()) {
    include(bounds, { x: box.x, y: box.y });
    include(bounds, { x: box.x + box.width, y: box.y + box.height });
    lowest = Math.max(lowest, box.y + box.height);
  }
  // A loop is drawn under every box, so it never crosses its own node (FR19).
  const loopY = lowest + LOOP_DROP;

  // Route every edge in the unshifted grid first: the offset is only known once every anchor and
  // control point has been folded into the bounds (a loop dips below the lowest box).
  const routed: {
    readonly edge: GraphEdge;
    readonly start: LayoutPoint;
    readonly c1: LayoutPoint;
    readonly c2: LayoutPoint;
    readonly end: LayoutPoint;
    readonly label: LayoutPoint;
  }[] = [];
  for (const edge of graph.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const loop = edge.loop === true;
    const start = {
      x: Math.round(from.x + from.width),
      y: Math.round(from.y + from.height / 2),
    };
    const end = { x: Math.round(to.x), y: Math.round(to.y + to.height / 2) };
    const c1 = { x: Math.round(start.x + CONTROL_REACH), y: start.y };
    const c2 = { x: Math.round(end.x - CONTROL_REACH), y: end.y };
    if (loop) {
      c1.y = Math.round(loopY);
      c2.y = Math.round(loopY);
    } else if (to.layer - from.layer > 1) {
      // A skip bends away from the boxes it passes; the sign follows the vertical direction.
      const bend = start.y <= end.y ? SKIP_BEND : -SKIP_BEND;
      c1.y = Math.round(start.y + bend);
      c2.y = Math.round(end.y + bend);
    }

    const label = midpoint(start, c1, c2, end);
    include(bounds, start);
    include(bounds, c1);
    include(bounds, c2);
    include(bounds, end);
    include(bounds, label);
    routed.push({ edge, start, c1, c2, end, label });
  }

  const shiftX = Math.round(padding - bounds.minX);
  const shiftY = Math.round(padding - bounds.minY);
  const width = Math.round(bounds.maxX - bounds.minX + padding * 2);
  const height = Math.round(bounds.maxY - bounds.minY + padding * 2);
  const move = (point: LayoutPoint): LayoutPoint => ({
    x: point.x + shiftX,
    y: point.y + shiftY,
  });

  return {
    nodes: [...boxes.values()].map((box) => ({
      ...box,
      x: box.x + shiftX,
      y: box.y + shiftY,
    })),
    edges: routed.map(({ edge, start, c1, c2, end, label }) => {
      const moved = { start: move(start), c1: move(c1), c2: move(c2), end: move(end) };
      const at = move(label);
      return {
        from: edge.from,
        to: edge.to,
        path: bezierPath(moved.start, moved.c1, moved.c2, moved.end),
        kind: edge.kind,
        loop: edge.loop === true,
        ...(edge.label === undefined ? {} : { label: edge.label }),
        labelX: at.x,
        labelY: at.y,
      };
    }),
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
  };
}
