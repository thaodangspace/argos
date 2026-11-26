<script lang="ts">
  import type { StepView } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  import CopyButton from "./CopyButton.svelte";
  import StatusGlyph from "./StatusGlyph.svelte";

  let { step }: { step: StepView } = $props();

  const LINE = "grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 px-3 py-px hover:bg-surface-200-800/60 max-sm:grid-cols-1 max-sm:gap-0";
  const MUTED = "text-[12px] text-surface-600-400";
</script>

<section
  class="card overflow-hidden border border-surface-200-800 bg-surface-100-900"
  aria-labelledby="step-log-title"
>
  <header class="flex flex-wrap items-center gap-2.5 border-b border-surface-200-800 px-3 py-2">
    <h2 id="step-log-title" class="m-0 text-sm font-semibold">{step.title}</h2>
    <span
      class={["inline-flex items-center gap-1 text-[12px] font-semibold", toneClass(TONE_TEXT, step.tone)]}
      data-tone={step.tone}
    >
      <StatusGlyph glyph={step.glyph} tone={step.tone} label={step.statusLabel} />
      {step.statusLabel}
    </span>
    {#if step.durationLabel}<span class={MUTED}>{step.durationLabel}</span>{/if}
    {#if step.usageLabel}<span class={MUTED}>{step.usageLabel}</span>{/if}
    <span class="flex-1"></span>
    <CopyButton text={step.logText} label="Copy step log" />
  </header>

  {#if step.attempts.length > 0}
    <div
      class="flex flex-col gap-0.5 border-b border-surface-200-800 px-3 py-2 text-[12px]"
    >
      {#each step.attempts as attempt (attempt.n)}
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-surface-600-400">#{attempt.n}</span>
          {#if attempt.target}<span class="font-mono">{attempt.target}</span>{/if}
          <span class={MUTED}>{attempt.durationLabel}</span>
          {#if attempt.outcome}
            <span
              class={toneClass(TONE_TEXT, attempt.outcome === "completed" ? "success" : "danger")}
              data-tone={attempt.outcome === "completed" ? "success" : "danger"}>{attempt.outcome}</span
            >
          {/if}
          {#if attempt.errorCode}<span
              class={toneClass(TONE_TEXT, "danger")}
              data-tone="danger">{attempt.errorCode}</span
            >{/if}
          {#if attempt.usageLabel}<span class={MUTED}>{attempt.usageLabel}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if step.outputs.length > 0}
    <div class="border-b border-surface-200-800">
      {#each step.outputs as output (output.name)}
        <div class="border-b border-surface-200-800 px-3 py-2 last:border-b-0">
          <div class="mb-1 text-[11px] tracking-[0.04em] text-surface-600-400 uppercase">
            {output.name}
          </div>
          <pre
            class="m-0 overflow-x-auto rounded-md border border-surface-200-800 bg-surface-200-800/40 p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{output.value}</pre>
        </div>
      {/each}
    </div>
  {/if}

  {#if step.log.length > 0}
    <ol class="m-0 max-h-[46vh] list-none overflow-y-auto py-1.5 font-mono text-xs">
      {#each step.log as line, index (index)}
        <li class={[LINE, toneClass(TONE_TEXT, line.tone)]} data-tone={line.tone}>
          <span class="tabular-nums text-surface-600-400 max-sm:text-[10px]">{line.timeLabel}</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="m-0 px-3 py-4 text-[12px] text-surface-600-400">No log for this step yet.</p>
  {/if}
</section>
