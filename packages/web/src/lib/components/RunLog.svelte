<script lang="ts">
  import type { StepLogEntry } from "@thaodangspace/argos-core/view";

  let { entries }: { entries: readonly StepLogEntry[] } = $props();
</script>

{#if entries.length > 0}
  <section class="run-log" aria-labelledby="run-log-title">
    <h2 id="run-log-title">Run log</h2>
    <ol>
      {#each entries as line, index (index)}
        <li class="tone-{line.tone}">
          <span class="time">{line.timeLabel}</span>
          <span class="text">{line.text}</span>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .run-log {
    margin-top: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
  }

  h2 {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px;
  }

  li {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 10px;
    padding: 1px 12px;
  }

  .time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
