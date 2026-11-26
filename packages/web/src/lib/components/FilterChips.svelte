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

<nav class="flex flex-wrap gap-1.5" aria-label="Filter workflow runs">
  {#each filters as filter (filter.id)}
    <button
      type="button"
      class="chip preset-tonal aria-pressed:preset-filled-primary-500"
      aria-pressed={filter.id === active}
      onclick={() => onSelect(filter.id)}
    >
      {filter.label}
      <span class="tabular-nums opacity-75">{filter.count}</span>
    </button>
  {/each}
</nav>
