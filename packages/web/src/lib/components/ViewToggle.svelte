<script lang="ts">
  import type { RunViewMode } from "#lib/view-query";

  /**
   * The segmented `Rail | Graph` control (D2): always visible in the run header, and the graph half
   * is disabled with a `graph unavailable` tooltip when the detail carries no graph (FR22), i.e.
   * against an older server. The choice itself is the page's URL state, never stored here.
   *
   * Two native `<button aria-pressed>` and nothing else: spec FR14 keeps this control out of the
   * Zag escalations, because the pressed-state contract is what the tests and the reader rely on.
   */
  let {
    view,
    graphAvailable,
    onView,
  }: {
    view: RunViewMode;
    graphAvailable: boolean;
    onView: (view: RunViewMode) => void;
  } = $props();

  const BUTTON =
    "btn btn-sm preset-tonal aria-pressed:preset-filled-primary-500 disabled:cursor-not-allowed disabled:opacity-50";
</script>

<div
  class="inline-flex items-center gap-0.5 rounded-md border border-surface-200-800 bg-surface-100-900 p-0.5"
  role="group"
  aria-label="View"
>
  <button
    type="button"
    class={BUTTON}
    aria-pressed={view === "rail"}
    onclick={() => onView("rail")}
  >
    Rail
  </button>
  <button
    type="button"
    class={BUTTON}
    aria-pressed={view === "graph"}
    disabled={!graphAvailable}
    title={graphAvailable ? "Graph view" : "graph unavailable"}
    onclick={() => onView("graph")}
  >
    Graph
  </button>
</div>
