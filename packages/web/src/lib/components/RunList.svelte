<script lang="ts">
  /**
   * The chronological run list (GitHub Actions' "Workflow runs"): one flat list, newest start first,
   * split by the reader's day, with one global "Load more" instead of per-workflow pagination.
   *
   * Flat is the point: grouping by workflow hides the interleaving of two schedules, which is exactly
   * the question an operator asks ("which workflow ran before this one?").
   */
  import type { DaySectionView, RunView } from "@thaodangspace/argos-core/view";

  import RunRow from "./RunRow.svelte";

  let {
    days,
    pageSize = 25,
    relative = "start",
    showPlaybook = false,
    showProject = false,
  }: {
    days: readonly DaySectionView[];
    pageSize?: number;
    relative?: "start" | "activity";
    showPlaybook?: boolean;
    showProject?: boolean;
  } = $props();

  let pages = $state(1);

  const rows = $derived(days.flatMap((day) => day.runs.map((run) => ({ day, run }))));
  const visible = $derived(rows.slice(0, pages * pageSize));
  const remaining = $derived(rows.length - visible.length);

  /** Re-fold the visible prefix into day sections, keeping each section's label. */
  const sections = $derived.by(() => {
    const out: { day: string; label: string; runs: RunView[] }[] = [];
    for (const entry of visible) {
      const last = out.at(-1);
      if (last === undefined || last.day !== entry.day.day) {
        out.push({ day: entry.day.day, label: entry.day.label, runs: [entry.run] });
      } else {
        last.runs.push(entry.run);
      }
    }
    return out;
  });
</script>

<div class="overflow-hidden rounded-lg border border-surface-200-800 bg-surface-100-900">
  {#each sections as section (section.day)}
    <section
      class="border-b border-surface-200-800 last:border-b-0"
      aria-labelledby={section.label === "" ? undefined : `day-${section.day}`}
    >
      {#if section.label !== ""}
        <h2
          id={`day-${section.day}`}
          class="sticky top-0 z-[1] m-0 border-b border-surface-200-800 bg-surface-200-800 px-3.5 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400"
        >
          {section.label}
        </h2>
      {/if}
      {#each section.runs as run (run.id)}
        <RunRow {run} {relative} {showPlaybook} {showProject} />
      {/each}
    </section>
  {/each}

  {#if remaining > 0}
    <button
      type="button"
      class="w-full border-0 border-t border-surface-200-800 bg-transparent p-2.5 text-[12px] text-primary-700-300 hover:bg-surface-200-800/60"
      onclick={() => (pages += 1)}
    >
      Load {Math.min(pageSize, remaining)} more
      <span class="text-surface-600-400">· {remaining} hidden</span>
    </button>
  {/if}
</div>
