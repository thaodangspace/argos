<script lang="ts">
  import type { RunFilter } from "@thaodangspace/argos-core/view";

  let {
    filters,
    active,
    onSelect,
  }: {
    filters: readonly { readonly id: RunFilter; readonly label: string; readonly count: number }[];
    active: RunFilter;
    onSelect: (filter: RunFilter) => void;
  } = $props();
</script>

<nav class="chips" aria-label="Filter workflow runs">
  {#each filters as filter (filter.id)}
    <button
      type="button"
      class:active={filter.id === active}
      aria-pressed={filter.id === active}
      onclick={() => onSelect(filter.id)}
    >
      {filter.label}
      <span class="count">{filter.count}</span>
    </button>
  {/each}
</nav>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
  }

  button:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--text);
  }

  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
</style>
