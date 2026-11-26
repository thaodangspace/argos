<script lang="ts">
  import type { StepLogEntry } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let { entries }: { entries: readonly StepLogEntry[] } = $props();

  const LINE = "grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 px-3 py-px";
</script>

{#if entries.length > 0}
  <section
    class="card mt-4 overflow-hidden border border-surface-200-800 bg-surface-100-900"
    aria-labelledby="run-log-title"
  >
    <h2
      id="run-log-title"
      class="m-0 border-b border-surface-200-800 px-3 py-2 text-[12px] tracking-[0.05em] text-surface-600-400 uppercase"
    >
      Run log
    </h2>
    <ol class="m-0 list-none py-1.5 font-mono text-xs">
      {#each entries as line, index (index)}
        <li class={[LINE, toneClass(TONE_TEXT, line.tone)]} data-tone={line.tone}>
          <span class="tabular-nums text-surface-600-400">{line.timeLabel}</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      {/each}
    </ol>
  </section>
{/if}
