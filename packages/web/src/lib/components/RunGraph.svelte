<script lang="ts">
  import { onMount } from "svelte";

  import type { GraphEdgeKind, PlaybookGraph } from "@thaodangspace/argos-core/rpc/contracts";
  import {
    layerGraph,
    type StatusTone,
    type StepView,
  } from "@thaodangspace/argos-core/view";

  import { TONE_FILL, toneClass } from "#lib/ui/tone";

  /**
   * The run page's DAG view (FR18–FR22): one `<svg>`, one focusable `<g role="button">` per node,
   * coloured by the step's status, clickable into the same `?step=` log the rail drives.
   *
   * Geometry is not computed here: `layerGraph` in the shared view model owns it, so the browser
   * never measures anything and the same graph always draws the same picture. The component only
   * joins the graph's nodes with the run's `StepView`s (the contract deliberately carries no status)
   * and holds the pan/zoom transform, which is presentation and never leaves this element.
   *
   * A pending gate is a ring plus an `n pending` badge on its node; a `skipped` step is drawn at
   * 40 % so a `when: false` branch is visibly not run. Above 60 nodes the drawing is fit to width
   * with a note, in a horizontally scrolling container, and is never truncated.
   */

  let {
    graph,
    steps,
    selectedId,
    onSelect,
  }: {
    graph: PlaybookGraph;
    steps: readonly StepView[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  } = $props();

  /** The rail's tone vocabulary plus the graph's (ok/warn/err/info); an unknown tone is neutral. */
  const TONE_ALIASES: Readonly<Record<string, StatusTone>> = {
    success: "success",
    ok: "success",
    warning: "warning",
    warn: "warning",
    danger: "danger",
    err: "danger",
    accent: "accent",
    info: "accent",
    neutral: "neutral",
  };

  /** One marker per edge kind (FR18), so an arrow is never mistaken for another kind. */
  const ARROW_KINDS: readonly GraphEdgeKind[] = ["needs", "goto", "ask", "branch", "end", "fail"];

  // Literal class strings only (spec FR4, FR16): Tailwind's scanner reads this file's text, so every
  // colour is written out here and referenced as `class={CONST}` — a `tone-{tone}` fragment would be
  // dropped in the production build, where no jsdom test looks. Geometry stays in the attributes
  // `layerGraph()` hands us; these constants only paint.
  const GRAPH =
    "flex min-w-0 flex-col gap-1.5 rounded-lg border border-surface-200-800 bg-surface-100-900 p-1.5";
  const SCROLLER = "overflow-x-auto overflow-y-hidden";
  const CANVAS = "block max-w-none cursor-grab touch-none active:cursor-grabbing";
  const NOTE = "m-0 px-1.5 py-0.5 text-[11px] text-surface-600-400";
  const DASHED = "[stroke-dasharray:5_4]";
  const EDGE_LABEL = "fill-surface-600-400 text-[10px]";
  const NODE = "group cursor-pointer outline-none";
  const NODE_BOX =
    "fill-surface-50-950 stroke-surface-300-700 transition-colors duration-[120ms] ease-out group-hover:stroke-surface-600-400 group-focus-visible:stroke-surface-600-400 [stroke-width:1] motion-reduce:transition-none";
  // The selection stroke replaces the resting one rather than overriding it: two `stroke-*` classes on
  // one element would be resolved by stylesheet order, not by class order (spec FR16).
  const NODE_BOX_SELECTED =
    "fill-surface-50-950 stroke-primary-500 transition-colors duration-[120ms] ease-out [stroke-width:2] motion-reduce:transition-none";
  const NODE_SKIPPED = "opacity-40";
  const LABEL = "fill-surface-950-50 text-[12px] font-medium";
  const GATE_RING = "fill-none stroke-warning-500 [stroke-width:1.5] [stroke-dasharray:3_3]";
  const GATE_BADGE = "fill-warning-500/15 stroke-warning-500 [stroke-width:1]";
  const GATE_COUNT = "fill-warning-500 text-[9px]";

  /** Edge strokes: `needs` is the muted relation, `ask` is heavier, `fail` is the danger one. */
  const EDGE: Readonly<Record<GraphEdgeKind, string>> = {
    needs: "fill-none stroke-surface-600-400 [stroke-width:1.5]",
    goto: "fill-none stroke-surface-300-700 [stroke-width:1.5]",
    ask: "fill-none stroke-surface-300-700 [stroke-width:2.5]",
    branch: "fill-none stroke-surface-300-700 [stroke-width:1.5]",
    end: "fill-none stroke-surface-300-700 [stroke-width:1.5]",
    fail: "fill-none stroke-error-500 [stroke-width:1.5]",
  };

  // A `<marker>`'s inner path never inherits `fill` (spec FR16), so every arrowhead names its own.
  const ARROW: Readonly<Record<GraphEdgeKind, string>> = {
    needs: "fill-surface-600-400",
    goto: "fill-surface-300-700",
    ask: "fill-surface-300-700",
    branch: "fill-surface-300-700",
    end: "fill-surface-300-700",
    fail: "fill-error-500",
  };

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 2;
  const ZOOM_STEP = 1.1;
  const DRAG_THRESHOLD = 3;
  const FIT_WIDTH = 900;
  const FIT_MIN_SCALE = 0.2;
  const TITLE_LIMIT = 22;

  let surface: HTMLDivElement | undefined = $state();
  let svg: SVGSVGElement | undefined = $state();

  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragged = $state(false);
  let dragging: { x: number; y: number; panX: number; panY: number } | null = null;

  const layout = $derived(layerGraph(graph));
  const graphById = $derived(new Map(graph.nodes.map((node) => [node.id, node])));
  const stepsById = $derived(new Map(steps.map((step) => [step.id, step])));
  const large = $derived(layout.nodes.length > 60);
  const fitScale = $derived(
    large ? clamp(FIT_WIDTH / layout.width, FIT_MIN_SCALE, 1) : 1,
  );
  const renderedWidth = $derived(Math.round(layout.width * fitScale));
  const renderedHeight = $derived(Math.round(layout.height * fitScale));

  function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
  }

  function toneOf(tone: string | undefined): StatusTone {
    return tone === undefined ? "neutral" : (TONE_ALIASES[tone] ?? "neutral");
  }

  function ellipsize(text: string): string {
    const characters = Array.from(text);
    return characters.length > TITLE_LIMIT
      ? `${characters.slice(0, TITLE_LIMIT).join("")}…`
      : text;
  }

  function pendingGates(step: StepView | undefined): number {
    if (step === undefined) return 0;
    return step.gates.filter((gate) => gate.status === "pending").length;
  }

  function nodeLabel(id: string, title: string, kind: string): string {
    const step = stepsById.get(id);
    return `${id} · ${title} · ${kind} · ${step?.statusLabel ?? "unknown"}`;
  }

  /** Zoom about a point in the viewport (`+`/`-` pass the element's centre). */
  function zoomAt(factor: number, clientX: number, clientY: number): void {
    const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === scale) return;
    const rect = svg?.getBoundingClientRect();
    const x = rect === undefined || rect.width === 0 ? 0 : (clientX - rect.left) / fitScale;
    const y = rect === undefined || rect.height === 0 ? 0 : (clientY - rect.top) / fitScale;
    // Keep the graph point under the cursor fixed while the scale changes (FR20).
    panX = x - ((x - panX) * next) / scale;
    panY = y - ((y - panY) * next) / scale;
    scale = next;
  }

  function zoomCentre(factor: number): void {
    const rect = surface?.getBoundingClientRect();
    zoomAt(factor, (rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2);
  }

  function reset(): void {
    scale = 1;
    panX = 0;
    panY = 0;
  }

  function choose(id: string): void {
    // A drag ends on the node it started on; that gesture pans, it does not select (FR20).
    if (dragged) return;
    onSelect(id);
  }

  function onNodeKeydown(event: KeyboardEvent, id: string): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(id);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY, panX, panY };
    dragged = false;
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragging === null) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (!dragged && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    dragged = true;
    panX = dragging.panX + dx / (fitScale * scale);
    panY = dragging.panY + dy / (fitScale * scale);
  }

  function onPointerUp(): void {
    dragging = null;
  }

  onMount(() => {
    const element = surface;
    if (element === undefined) return;

    // A non-passive listener, so a wheel over the graph zooms it instead of scrolling the page.
    const onWheel = (event: WheelEvent): void => {
      if (event.cancelable) event.preventDefault();
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });

    const onKeydown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (event.key === "+" || event.key === "=") {
        zoomCentre(ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        zoomCentre(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        reset();
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeydown);

    return () => {
      element.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeydown);
    };
  });
</script>

<div class={GRAPH} bind:this={surface}>
  {#if large}
    <p class={NOTE}>too large to fit — scroll to explore</p>
  {/if}
  <div class={SCROLLER}>
    <svg
      bind:this={svg}
      class={CANVAS}
      viewBox={layout.viewBox}
      width={renderedWidth}
      height={renderedHeight}
      role="group"
      aria-label="Playbook graph"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerUp}
    >
      <defs>
        {#each ARROW_KINDS as kind (kind)}
          <marker
            id={`argos-arrow-${kind}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path class={ARROW[kind]} d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        {/each}
      </defs>

      <g transform={`translate(${panX} ${panY}) scale(${scale})`}>
        <g>
          {#each layout.edges as edge (`${edge.from}→${edge.to}:${edge.kind}:${edge.label ?? ""}`)}
            {@const dashed = edge.kind === "goto" || edge.kind === "branch" || edge.loop === true}
            <path
              class={[EDGE[edge.kind], dashed && DASHED]}
              d={edge.path}
              marker-end={`url(#argos-arrow-${edge.kind})`}
            />
            {#if edge.label !== undefined}
              <text class={EDGE_LABEL} x={edge.labelX} y={edge.labelY} text-anchor="middle">
                {edge.label}
              </text>
            {/if}
          {/each}
        </g>

        <g>
          {#each layout.nodes as node (node.id)}
            {@const source = graphById.get(node.id)}
            {@const title = source?.title ?? node.id}
            {@const kind = source?.kind ?? "agent"}
            {@const step = stepsById.get(node.id)}
            {@const tone = toneOf(step?.tone)}
            {@const pending = pendingGates(step)}
            {@const selected = node.id === selectedId}
            {@const skipped = step?.status === "skipped"}
            <g
              class={[NODE, skipped && NODE_SKIPPED]}
              role="button"
              tabindex="0"
              aria-label={nodeLabel(node.id, title, kind)}
              data-node-id={node.id}
              data-selected={selected ? "true" : undefined}
              data-skipped={skipped ? "true" : undefined}
              onclick={() => choose(node.id)}
              onkeydown={(event) => onNodeKeydown(event, node.id)}
            >
              <title>{nodeLabel(node.id, title, kind)}</title>
              <rect
                class={selected ? NODE_BOX_SELECTED : NODE_BOX}
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx="8"
              />
              {#if pending > 0}
                <rect
                  class={GATE_RING}
                  data-gate="ring"
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx="8"
                />
                <rect
                  class={GATE_BADGE}
                  data-gate="badge"
                  x={node.x + node.width - 64}
                  y={node.y + 6}
                  width="58"
                  height="16"
                  rx="8"
                />
                <text
                  class={GATE_COUNT}
                  data-gate-count
                  x={node.x + node.width - 35}
                  y={node.y + 17}
                  text-anchor="middle"
                >
                  {pending} pending
                </text>
              {/if}
              <circle
                class={toneClass(TONE_FILL, tone)}
                data-tone={tone}
                cx={node.x + 13}
                cy={node.y + 24}
                r="4.5"
              />
              <text class={LABEL} x={node.x + 24} y={node.y + 29}>{ellipsize(title)}</text>
            </g>
          {/each}
        </g>
      </g>
    </svg>
  </div>
</div>
