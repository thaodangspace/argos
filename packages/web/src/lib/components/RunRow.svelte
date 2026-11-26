<script lang="ts">
  import type { RunView } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";
  import ProgressDots from "./ProgressDots.svelte";
  import StatusGlyph from "./StatusGlyph.svelte";
  import { runHref } from "../paths.js";

  let {
    run,
    showPlaybook = false,
    showProject = false,
    relative = "start",
  }: {
    run: RunView;
    showPlaybook?: boolean;
    showProject?: boolean;
    /** Which timestamp the row reads: the timeline's start, or the last activity. */
    relative?: "start" | "activity";
  } = $props();

  const relativeLabel = $derived(
    relative === "activity" ? run.updatedRelative : run.startedRelative,
  );
  const relativeTitle = $derived(
    relative === "activity" ? `updated ${run.updatedLabel}` : `started ${run.createdLabel}`,
  );

  const ROW =
    "card grid grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-surface-200-800 px-3.5 py-2.5 text-surface-950-50 hover:bg-surface-200-800/60 max-sm:grid-cols-[20px_minmax(0,1fr)]";
  const TIMES =
    "flex min-w-[88px] flex-col items-end text-[12px] tabular-nums text-surface-600-400 max-sm:col-start-2 max-sm:min-w-0 max-sm:flex-row max-sm:justify-start max-sm:gap-2";
</script>

<a class={ROW} href={runHref(run.id)} aria-label={`Run ${run.runIdShort} of ${run.playbookId}: ${run.statusLabel}`}>
  <span class="flex justify-center">
    <StatusGlyph glyph={run.glyph} tone={run.tone} label={run.statusLabel} pulse={run.status === "running"} />
  </span>

  <span class="flex min-w-0 flex-col gap-0.5">
    <span class="flex min-w-0 items-baseline gap-2">
      {#if showProject && run.project !== ""}<span
          class="whitespace-nowrap rounded border border-surface-200-800 px-1 text-[11px] text-surface-600-400"
          >{run.project}</span
        >{/if}
      {#if showPlaybook}<span class="whitespace-nowrap font-semibold">{run.playbookId}</span>{/if}
      <span class="truncate text-surface-600-400">{run.detail}</span>
      <span class="whitespace-nowrap font-mono text-[12px] text-surface-600-400">#{run.runIdShort}</span>
    </span>
    <span class="flex flex-wrap gap-2 text-[12px] text-surface-600-400">
      <span class="badge {toneClass(TONE_TEXT, run.tone)}" data-tone={run.tone}>{run.statusLabel}</span>
      <span class="capitalize">{run.triggerLabel}</span>
      {#if run.executor}<span class="rounded border border-surface-200-800 px-1">{run.executor}</span>{/if}
      {#if run.costLabel}<span>{run.costLabel}</span>{/if}
    </span>
  </span>

  <span class="flex items-center max-sm:col-start-2 max-sm:flex-row max-sm:justify-start"
    ><ProgressDots steps={run.progress} /></span
  >

  <span class={TIMES}>
    <span class="text-surface-950-50">{run.durationLabel}</span>
    <span title={relativeTitle}>{relativeLabel}</span>
  </span>
</a>
