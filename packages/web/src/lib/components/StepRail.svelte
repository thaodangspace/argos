<script lang="ts">
  import type { StepView } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  import StatusGlyph from "./StatusGlyph.svelte";

  let {
    steps,
    selectedId,
    onSelect,
  }: {
    steps: readonly StepView[];
    selectedId: string | null;
    onSelect: (stepId: string) => void;
  } = $props();

  const pendingGates = (step: StepView): number =>
    step.gates.filter((gate) => gate.status === "pending").length;

  // Literal class strings (spec FR4): Tailwind's scanner reads this file's text.
  const RAIL =
    "flex flex-col gap-0.5 self-start overflow-y-auto rounded-lg border border-surface-200-800 bg-surface-100-900 lg:sticky lg:top-3 lg:max-h-[calc(100vh-140px)]";
  const STEP =
    "grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-2 border-l-[3px] border-l-transparent px-2.5 py-2 text-left text-surface-950-50 hover:bg-surface-200-800/60 aria-[current=step]:border-l-primary-500 aria-[current=step]:bg-primary-500/15";
</script>

<nav class={RAIL} aria-label="Steps">
  {#each steps as step (step.id)}
    <button
      type="button"
      class={STEP}
      aria-current={step.id === selectedId ? "step" : undefined}
      onclick={() => onSelect(step.id)}
    >
      <span class="pt-px">
        <StatusGlyph
          glyph={step.glyph}
          tone={step.tone}
          label={step.statusLabel}
          pulse={step.status === "running"}
        />
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-[13px] font-medium">{step.title}</span>
        <span class="mt-px flex flex-wrap gap-1.5 text-[11px] text-surface-600-400">
          <span class={toneClass(TONE_TEXT, step.tone)} data-tone={step.tone}
            >{step.statusLabel}</span
          >
          <span class="opacity-85">{step.kindLabel}</span>
          {#if step.attemptCount > 1}<span class="opacity-85">{step.attemptCount} attempts</span>{/if}
          {#if step.durationLabel}<span class="opacity-85">{step.durationLabel}</span>{/if}
          {#if pendingGates(step) > 0}
            <span class={toneClass(TONE_TEXT, "warning")} data-tone="warning"
              >{pendingGates(step)} pending</span
            >
          {/if}
        </span>
      </span>
    </button>
  {/each}
</nav>
