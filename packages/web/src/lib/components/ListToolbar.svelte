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

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";
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

  const SORT_BUTTON =
    "btn rounded-none border-r border-surface-200-800 text-[12px] font-normal text-surface-700-300 last:border-r-0 aria-pressed:bg-primary-500/15 aria-pressed:font-semibold aria-pressed:text-surface-950-50";
  const FACET_LABEL =
    "inline-flex items-center gap-1.5 text-[12px] text-surface-600-400 whitespace-nowrap";
  const FACET_SELECT = "select w-auto text-[12px]";
</script>

<section class="mb-3 flex flex-col gap-2" aria-label="Filter workflow runs">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="m-0 text-[13px] tabular-nums text-surface-600-400" aria-live="polite">
      <strong class="text-surface-950-50">{total}</strong>
      {total === 1 ? "run" : "runs"}
      {#if running > 0}
        <span class="mx-1.5 opacity-60">·</span><span
          class={toneClass(TONE_TEXT, "accent")}
          data-tone="accent">{running} in progress</span
        >
      {/if}
    </p>
    <div class="inline-flex overflow-hidden rounded-md border border-surface-200-800" role="group" aria-label="Order">
      {#each RUN_SORTS as option (option)}
        <button
          type="button"
          class={SORT_BUTTON}
          aria-pressed={sort === option}
          onclick={() => onSort(option)}
        >
          {RUN_SORT_LABELS[option]}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex flex-wrap items-center justify-between gap-3">
    <FilterChips {filters} active={query.status} onSelect={onStatus} />

    <div class="flex flex-wrap items-center gap-2">
      {#if facets.projects.length > 1}
        <label class={FACET_LABEL}>
          <span>Project</span>
          <select
            class={FACET_SELECT}
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

      <label class={FACET_LABEL}>
        <span>Workflow</span>
        <select
          class={FACET_SELECT}
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

      <label class={FACET_LABEL}>
        <span>Trigger</span>
        <select
          class={FACET_SELECT}
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
        <label class={FACET_LABEL}>
          <span>Executor</span>
          <select
            class={FACET_SELECT}
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
