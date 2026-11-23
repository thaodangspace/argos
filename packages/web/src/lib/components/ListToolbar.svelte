<script lang="ts">
  /**
   * The list toolbar: the status chips, the facet selects and the order toggle.
   *
   * Mirrors GitHub Actions' "Workflow runs" toolbar (count · filters · sort). The rail offers the same
   * facets as navigation; these selects are what keeps them reachable on a narrow screen, and both
   * write the one `ListState` in the address bar.
   */
  import {
    RUN_SORTS,
    RUN_SORT_LABELS,
    RUN_TRIGGERS,
    RUN_TRIGGER_LABELS,
    type FacetOption,
    type RunFacets,
    type RunFilter,
    type RunListQuery,
    type RunSort,
    type RunTriggerFacet,
  } from "@thaodangspace/argos-core/view";

  import FilterChips from "./FilterChips.svelte";

  let {
    filters,
    query,
    facets,
    sort,
    total,
    running,
    onStatus,
    onFacet,
    onSort,
  }: {
    filters: readonly { readonly id: RunFilter; readonly label: string; readonly count: number }[];
    query: RunListQuery;
    facets: RunFacets;
    sort: RunSort;
    total: number;
    /** Runs that still need a process (the `Running` chip's count, not only `status: running`). */
    running: number;
    onStatus: (status: RunFilter) => void;
    onFacet: (facet: "project" | "workflow" | "trigger" | "executor", value: string | undefined) => void;
    onSort: (sort: RunSort) => void;
  } = $props();

  const triggerOptions = $derived(
    RUN_TRIGGERS.map((id) => facets.triggers.find((entry) => entry.id === id)).filter(
      (entry): entry is FacetOption => entry !== undefined,
    ),
  );
</script>

<section class="toolbar" aria-label="Filter workflow runs">
  <div class="row">
    <p class="count" aria-live="polite">
      <strong>{total}</strong>
      {total === 1 ? "run" : "runs"}
      {#if running > 0}
        <span class="sep">·</span><span class="tone-accent">{running} in progress</span>
      {/if}
    </p>
    <div class="sort" role="group" aria-label="Order">
      {#each RUN_SORTS as option (option)}
        <button
          type="button"
          class:active={sort === option}
          aria-pressed={sort === option}
          onclick={() => onSort(option)}
        >
          {RUN_SORT_LABELS[option]}
        </button>
      {/each}
    </div>
  </div>

  <div class="row">
    <FilterChips {filters} active={query.status} onSelect={onStatus} />

    <div class="facets">
      {#if facets.projects.length > 1}
        <label>
          <span>Project</span>
          <select
            value={query.project ?? ""}
            onchange={(event) =>
              onFacet("project", (event.currentTarget as HTMLSelectElement).value || undefined)}
          >
            <option value="">All projects</option>
            {#each facets.projects as entry (entry.id)}
              <option value={entry.id}>{entry.id} ({entry.count})</option>
            {/each}
          </select>
        </label>
      {/if}

      <label>
        <span>Workflow</span>
        <select
          value={query.workflow ?? ""}
          onchange={(event) =>
            onFacet("workflow", (event.currentTarget as HTMLSelectElement).value || undefined)}
        >
          <option value="">All workflows</option>
          {#each facets.workflows as entry (entry.id)}
            <option value={entry.id}>{entry.id} ({entry.count})</option>
          {/each}
        </select>
      </label>

      <label>
        <span>Trigger</span>
        <select
          value={query.trigger ?? ""}
          onchange={(event) =>
            onFacet(
              "trigger",
              (event.currentTarget as HTMLSelectElement).value || undefined,
            )}
        >
          <option value="">Any trigger</option>
          {#each triggerOptions as entry (entry.id)}
            <option value={entry.id}>{RUN_TRIGGER_LABELS[entry.id as RunTriggerFacet]} ({entry.count})</option>
          {/each}
        </select>
      </label>

      {#if facets.executors.length > 1}
        <label>
          <span>Executor</span>
          <select
            value={query.executor ?? ""}
            onchange={(event) =>
              onFacet("executor", (event.currentTarget as HTMLSelectElement).value || undefined)}
          >
            <option value="">Any executor</option>
            {#each facets.executors as entry (entry.id)}
              <option value={entry.id}>{entry.id} ({entry.count})</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </div>
</section>

<style>
  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .count {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .count strong {
    color: var(--text);
  }

  .sep {
    margin: 0 6px;
    opacity: 0.6;
  }

  .sort {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .sort button {
    padding: 4px 10px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }

  .sort button + button {
    border-left: 1px solid var(--border);
  }

  .sort button:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .sort button.active {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 600;
  }

  .facets {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  select {
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
</style>
