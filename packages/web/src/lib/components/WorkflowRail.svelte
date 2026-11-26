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
   *
   * The idle toggle is a native `<button aria-expanded aria-controls>` with a conditional render, not
   * a Skeleton `Collapsible`: spec FR12 caps the Zag escalations at three and this surface carries no
   * behaviour a disclosure button does not already have.
   */
  import type { FacetOption, RunFacets, RunListQuery } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

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

  // Literal class strings (never built by concatenation): Tailwind's scanner reads this file's text.
  const HEADING =
    "mt-2 mb-0.5 px-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400";
  const ROW =
    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-surface-700-300 hover:bg-surface-200-800/60 aria-[current=true]:bg-primary-500/15 aria-[current=true]:font-semibold aria-[current=true]:text-surface-950-50";
  const WORKFLOW_ROW =
    "flex w-full min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-surface-700-300 hover:bg-surface-200-800/60 aria-[current=true]:bg-primary-500/15 aria-[current=true]:font-semibold aria-[current=true]:text-surface-950-50";
  const COUNT = "inline-flex items-center gap-1 text-[12px] tabular-nums text-surface-600-400";

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

<nav
  class="sticky top-3 flex flex-col gap-1 rounded-lg border border-surface-200-800 bg-surface-100-900 p-2 text-[13px]"
  aria-label="Run scope"
>
  <button
    type="button"
    class={ROW}
    aria-current={unscoped ? "true" : undefined}
    onclick={() => onSelect({ workflow: undefined, project: undefined })}
  >
    <span class="truncate">All workflows</span>
    <span class={COUNT}>{total}</span>
  </button>

  {#if live.length > 0}
    <section class="flex flex-col gap-1" aria-labelledby="rail-workflows">
      <h2 id="rail-workflows" class={HEADING}>Workflows</h2>
      {#each live as entry (entry.id)}
        {@render workflowRow(entry)}
      {/each}
    </section>
  {/if}

  {#if idle.length > 0}
    <section class="flex flex-col gap-1" aria-label="Idle workflows">
      {#if live.length > 0}
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400 hover:bg-surface-200-800/60"
          aria-expanded={idleShown}
          aria-controls="rail-idle-list"
          onclick={() => (idleOpen = !idleOpen)}
        >
          <span>Idle</span>
          <span class={COUNT}>{idle.length}</span>
        </button>
      {:else}
        <h2 class={HEADING}>Workflows</h2>
      {/if}

      {#if idleShown}
        <div id="rail-idle-list" class="flex flex-col gap-1">
          {#each idle as entry (entry.id)}
            {@render workflowRow(entry)}
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if facets.projects.length > 1}
    <section class="flex flex-col gap-1" aria-labelledby="rail-projects">
      <h2 id="rail-projects" class={HEADING}>Projects</h2>
      {#each facets.projects as entry (entry.id)}
        <button
          type="button"
          class={ROW}
          aria-current={query.project === entry.id ? "true" : undefined}
          title={entry.id}
          onclick={() => onSelect({ project: entry.id })}
        >
          <span class="truncate">{entry.id}</span>
          <span class={COUNT} title={breakdown(entry)}>
            {#if entry.active > 0}<span
                class="text-[9px] {toneClass(TONE_TEXT, 'accent')}"
                data-tone="accent"
                aria-hidden="true">●</span
              >{/if}
            {entry.count}
          </span>
        </button>
      {/each}
    </section>
  {/if}

  {#if hiddenCount > 0}
    <button
      type="button"
      class="mt-1 rounded-md border border-surface-200-800 px-2 py-1 text-left text-[11px] text-surface-600-400 hover:bg-surface-200-800/60 hover:text-surface-950-50"
      onclick={onShowHidden}
    >
      {hiddenCount} hidden · Show
    </button>
  {/if}
</nav>

{#snippet workflowRow(entry: FacetOption)}
  <div class="group flex items-center rounded-md">
    <button
      type="button"
      class={WORKFLOW_ROW}
      aria-current={query.workflow === entry.id ? "true" : undefined}
      title={entry.id}
      onclick={() => onSelect({ workflow: entry.id })}
    >
      <span class="truncate {entry.live ? '' : 'text-surface-600-400'}">{entry.id}</span>
      <span class={COUNT} title={breakdown(entry)}>
        {#if entry.active > 0}<span
            class="text-[9px] {toneClass(TONE_TEXT, 'accent')}"
            data-tone="accent"
            aria-hidden="true">●</span
          >{/if}
        {entry.count}
      </span>
    </button>
    {#if query.workflow !== entry.id}
      <button
        type="button"
        class="btn-icon shrink-0 text-[11px] opacity-40 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={`Hide ${entry.id}`}
        title={`Hide ${entry.id} from this rail (nothing is deleted)`}
        onclick={() => onHide(entry.id)}
      >
        ✕
      </button>
    {/if}
  </div>
{/snippet}
