<script lang="ts">
  import type { WorkflowGroupView } from "@thaodangspace/argos-core/view";

  import RunRow from "./RunRow.svelte";
  import StatusGlyph from "./StatusGlyph.svelte";

  let {
    group,
    pageSize = 20,
  }: { group: WorkflowGroupView; pageSize?: number } = $props();

  let expanded = $state(true);
  let pages = $state(1);
  const visible = $derived(group.runs.slice(0, pages * pageSize));
  const upcoming = $derived(group.runs.length - pages * pageSize);
</script>

<section class="group" aria-labelledby={`group-${group.playbookId}`}>
  <header>
    <button
      type="button"
      class="toggle"
      aria-expanded={expanded}
      aria-controls={`rows-${group.playbookId}`}
      onclick={() => (expanded = !expanded)}
    >
      <span class="chevron" class:open={expanded} aria-hidden="true">›</span>
      <h2 id={`group-${group.playbookId}`}>{group.playbookId}</h2>
    </button>
    <div class="meta">
      <StatusGlyph
        glyph={group.latest.glyph}
        tone={group.latest.tone}
        label={`latest run ${group.latest.statusLabel}`}
      />
      <span>{group.total}</span>
      {#if group.active > 0}<span class="tone-accent">{group.active} running</span>{/if}
      {#if group.failed > 0}<span class="tone-danger">{group.failed} failed</span>{/if}
      {#if group.pendingGates > 0}<span class="tone-warning">{group.pendingGates} gate</span>{/if}
    </div>
  </header>

  {#if expanded}
    <div id={`rows-${group.playbookId}`} class="rows">
      {#each visible as run (run.id)}
        <RunRow {run} />
      {/each}
      {#if upcoming > 0}
        <button type="button" class="more" onclick={() => (pages += 1)}>
          Show {Math.min(pageSize, upcoming)} more
        </button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .group {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
    margin-bottom: 12px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px 8px 8px;
    background: var(--surface);
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    padding: 2px 4px;
    cursor: pointer;
    color: var(--text);
    min-width: 0;
  }

  .chevron {
    display: inline-block;
    transition: transform 120ms ease;
    color: var(--muted);
    width: 12px;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  h2 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .rows {
    border-top: 1px solid var(--border);
  }

  .rows :global(.row:first-child) {
    border-top: 0;
  }

  .more {
    width: 100%;
    padding: 8px;
    border: 0;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
  }

  .more:hover {
    background: var(--surface-hover);
  }
</style>
