<script lang="ts">
  /**
   * The scope rail (GitHub Actions-shaped): "All workflows" then one entry per workflow and one per
   * project. A workflow is a lens, not a group — the list stays chronological, so this replaces the
   * collapsible group headers that used to hide the "which ran before which" answer.
   *
   * The inventory is split in two: **in use** (a live run or an enabled schedule) and **idle** (old
   * one-off runs). Idle entries stay collapsed unless nothing is in use, and any workflow can be
   * hidden from the rail (`onHide`, remembered in `localStorage` by the page) — hiding is a view
   * preference, so a hidden schedule keeps firing and nothing is deleted.
   */
  import type { FacetOption, RunFacets, RunListQuery } from "@thaodangspace/argos-core/view";

  let {
    facets,
    query,
    total,
    hidden = [],
    onSelect,
    onHide,
    onShowHidden,
  }: {
    facets: RunFacets;
    query: RunListQuery;
    total: number;
    hidden?: readonly string[];
    onSelect: (scope: { workflow?: string | undefined; project?: string | undefined }) => void;
    onHide: (workflowId: string) => void;
    /** Unhide every workflow the browser remembers hiding. */
    onShowHidden: () => void;
  } = $props();

  const unscoped = $derived(query.workflow === undefined && query.project === undefined);

  const visible = $derived(facets.workflows.filter((entry) => !hidden.includes(entry.id)));
  const live = $derived(visible.filter((entry) => entry.live));
  const idle = $derived(visible.filter((entry) => !entry.live));
  const hiddenCount = $derived(facets.workflows.filter((entry) => hidden.includes(entry.id)).length);

  let idleOpen = $state(false);
  // A server whose workflows are all idle (no schedules yet) must not show an empty rail.
  const idleShown = $derived(idleOpen || live.length === 0);

  /**
   * The rail shows one count per entry: a glyph next to a number read as a count of that glyph
   * (`✕ 48` looked like forty-eight failures). The breakdown is the tooltip instead.
   */
  function breakdown(entry: FacetOption): string {
    const parts = [`${entry.count} runs`];
    if (entry.active > 0) parts.push(`${entry.active} in progress`);
    if (entry.failed > 0) parts.push(`${entry.failed} failed`);
    if (!entry.live) parts.push("idle");
    return parts.join(" · ");
  }
</script>

<nav class="rail" aria-label="Run scope">
  <button
    type="button"
    class="row scope"
    class:active={unscoped}
    aria-current={unscoped ? "true" : undefined}
    onclick={() => onSelect({ workflow: undefined, project: undefined })}
  >
    <span class="name">All workflows</span>
    <span class="count">{total}</span>
  </button>

  {#if live.length > 0}
    <section aria-labelledby="rail-workflows">
      <h2 id="rail-workflows">Workflows</h2>
      {#each live as entry (entry.id)}
        {@render workflowRow(entry)}
      {/each}
    </section>
  {/if}

  {#if idle.length > 0}
    <section aria-label="Idle workflows">
      {#if live.length > 0}
        <button
          type="button"
          class="row section-toggle"
          aria-expanded={idleShown}
          aria-controls="rail-idle-list"
          onclick={() => (idleOpen = !idleOpen)}
        >
          <span class="heading">Idle</span>
          <span class="count">{idle.length}</span>
        </button>
      {:else}
        <h2>Workflows</h2>
      {/if}

      {#if idleShown}
        <div id="rail-idle-list">
          {#each idle as entry (entry.id)}
            {@render workflowRow(entry)}
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if facets.projects.length > 1}
    <section aria-labelledby="rail-projects">
      <h2 id="rail-projects">Projects</h2>
      {#each facets.projects as entry (entry.id)}
        <button
          type="button"
          class="row scope"
          class:active={query.project === entry.id}
          aria-current={query.project === entry.id ? "true" : undefined}
          title={entry.id}
          onclick={() => onSelect({ project: entry.id })}
        >
          <span class="name">{entry.id}</span>
          <span class="count" title={breakdown(entry)}>
            {#if entry.active > 0}<span class="dot tone-accent" aria-hidden="true">●</span>{/if}
            {entry.count}
          </span>
        </button>
      {/each}
    </section>
  {/if}

  {#if hiddenCount > 0}
    <button type="button" class="footer" onclick={onShowHidden}>
      {hiddenCount} hidden · Show
    </button>
  {/if}
</nav>

{#snippet workflowRow(entry: FacetOption)}
  <div class="wrap" class:active={query.workflow === entry.id}>
    <button
      type="button"
      class="row scope"
      class:active={query.workflow === entry.id}
      class:idle={!entry.live}
      aria-current={query.workflow === entry.id ? "true" : undefined}
      title={entry.id}
      onclick={() => onSelect({ workflow: entry.id })}
    >
      <span class="name">{entry.id}</span>
      <span class="count" title={breakdown(entry)}>
        {#if entry.active > 0}<span class="dot tone-accent" aria-hidden="true">●</span>{/if}
        {entry.count}
      </span>
    </button>
    {#if query.workflow !== entry.id}
      <button
        type="button"
        class="hide"
        aria-label={`Hide ${entry.id}`}
        title={`Hide ${entry.id} from this rail (nothing is deleted)`}
        onclick={() => onHide(entry.id)}
      >
        ✕
      </button>
    {/if}
  </div>
{/snippet}

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 6px;
    position: sticky;
    top: 12px;
  }

  h2 {
    margin: 10px 6px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .heading {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .wrap {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }

  .wrap:hover,
  .wrap.active {
    background: var(--accent-soft);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }

  .scope:hover {
    background: var(--surface-hover);
  }

  .wrap .scope,
  .wrap .scope:hover {
    background: transparent;
  }

  .scope.active {
    color: var(--text);
    font-weight: 600;
  }

  .scope.idle .name {
    color: var(--muted);
  }

  .section-toggle:hover {
    background: var(--surface-hover);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .dot {
    font-size: 9px;
  }

  /* Reachable by pointer, keyboard and touch: dimmed until the row is touched. */
  .hide {
    flex: 0 0 auto;
    padding: 0 6px;
    border: 0;
    background: transparent;
    color: var(--muted);
    opacity: 0.4;
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
  }

  .wrap:hover .hide,
  .hide:focus-visible {
    opacity: 1;
    color: var(--text);
  }

  .footer {
    margin-top: 6px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 11px;
    text-align: left;
  }

  .footer:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
</style>
