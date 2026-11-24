<script lang="ts">
  import type { RunViewMode } from "#lib/view-query";

  /**
   * The segmented `Rail | Graph` control (D2): always visible in the run header, and the graph half
   * is disabled with a `graph unavailable` tooltip when the detail carries no graph (FR22), i.e.
   * against an older server. The choice itself is the page's URL state, never stored here.
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
</script>

<div class="toggle" role="group" aria-label="View">
  <button
    type="button"
    class:active={view === "rail"}
    aria-pressed={view === "rail"}
    onclick={() => onView("rail")}
  >
    Rail
  </button>
  <button
    type="button"
    class:active={view === "graph"}
    aria-pressed={view === "graph"}
    disabled={!graphAvailable}
    title={graphAvailable ? "Graph view" : "graph unavailable"}
    onclick={() => onView("graph")}
  >
    Graph
  </button>
</div>

<style>
  .toggle {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
  }

  button {
    padding: 3px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }

  button:hover:not(:disabled):not(.active) {
    background: var(--surface-hover);
    color: var(--text);
  }

  button.active {
    background: var(--accent-soft);
    color: var(--text);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
