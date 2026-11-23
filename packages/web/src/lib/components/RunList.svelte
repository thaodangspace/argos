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

<div class="list">
  {#each sections as section (section.day)}
    <section class="day" aria-labelledby={section.label === "" ? undefined : `day-${section.day}`}>
      {#if section.label !== ""}
        <h2 id={`day-${section.day}`}>{section.label}</h2>
      {/if}
      {#each section.runs as run (run.id)}
        <RunRow {run} {relative} {showPlaybook} {showProject} />
      {/each}
    </section>
  {/each}

  {#if remaining > 0}
    <button type="button" class="more" onclick={() => (pages += 1)}>
      Load {Math.min(pageSize, remaining)} more
      <span class="remaining">· {remaining} hidden</span>
    </button>
  {/if}
</div>

<style>
  .list {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
  }

  .day h2 {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0;
    padding: 4px 14px;
    background: var(--surface-hover);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .day + .day h2 {
    border-top: 1px solid var(--border);
  }

  .more {
    width: 100%;
    padding: 10px;
    border: 0;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
  }

  .more:hover {
    background: var(--surface-hover);
  }

  .remaining {
    color: var(--muted);
  }
</style>
