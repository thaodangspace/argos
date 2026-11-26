<script lang="ts">
  import type { Snippet } from "svelte";
  import { shortId, type RunView } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  import StatusGlyph from "./StatusGlyph.svelte";

  let { run, actions }: { run: RunView; actions?: Snippet } = $props();
</script>

<header
  class="mb-4 flex flex-col gap-4 border-b border-surface-200-800 pb-3.5 sm:flex-row sm:items-start sm:justify-between"
>
  <div class="min-w-0">
    <h1 class="m-0 flex flex-wrap items-baseline gap-2 text-lg font-semibold">
      {run.playbookId}
      <span class="font-mono text-[13px] font-normal text-surface-600-400">#{run.runIdShort}</span>
    </h1>
    <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-surface-600-400">
      <span
        class={["inline-flex items-center gap-1 font-semibold", toneClass(TONE_TEXT, run.tone)]}
        data-tone={run.tone}
      >
        <StatusGlyph
          glyph={run.glyph}
          tone={run.tone}
          label={run.statusLabel}
          pulse={run.status === "running"}
        />
        {run.statusLabel}
      </span>
      <span class="opacity-50" aria-hidden="true">·</span>
      <span class="capitalize">{run.triggerLabel}</span>
      <span class="opacity-50" aria-hidden="true">·</span>
      <span class="tabular-nums">{run.durationLabel}</span>
      {#if run.executor}<span
          class="rounded border border-surface-200-800 px-1.5 text-surface-950-50">{run.executor}</span
        >{/if}
      {#if run.forkedFrom}
        <span class="rounded border border-surface-200-800 px-1.5 text-surface-950-50">
          forked from #{shortId(run.forkedFrom.runId)} @ {run.forkedFrom.stepId}
        </span>
      {/if}
      {#if run.scheduleId}<span
          class="rounded border border-surface-200-800 px-1.5 text-surface-950-50">schedule</span
        >{/if}
    </div>
    <div class="mt-1.5 flex flex-wrap gap-2.5 font-mono text-[12px] text-surface-600-400">
      <span class="max-w-[60ch] truncate" title={run.cwd}>{run.cwd}</span>
      {#each run.inputs as input (input.name)}
        <span class="max-w-[32ch] truncate text-surface-950-50" title={`${input.name}=${input.value}`}
          >{input.name}={input.value}</span
        >
      {/each}
      {#if run.worktree}<span class="max-w-[60ch] truncate" title={run.worktree}
          >worktree {run.worktree}</span
        >{/if}
      {#if run.usageLabel}<span class="font-sans">{run.usageLabel}</span>{/if}
    </div>
  </div>
  <div class="flex flex-wrap justify-end gap-2 max-sm:justify-start">
    {@render actions?.()}
  </div>
</header>
