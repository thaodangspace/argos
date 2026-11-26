<script lang="ts">
  import type { StepProgressView } from "@thaodangspace/argos-core/view";

  import { TONE_BG_SOFT, toneClass } from "#lib/ui/tone";

  let { steps }: { steps: readonly StepProgressView[] } = $props();
</script>

<span class="inline-flex items-center gap-1" aria-hidden="true">
  {#each steps as step (step.id)}
    <span
      class="size-1.5 rounded-full opacity-85 {toneClass(TONE_BG_SOFT, step.tone)}"
      data-dot={step.id}
      data-tone={step.tone}
      title={`${step.label}: ${step.status}`}
    ></span>
  {/each}
</span>
{#if steps.length > 0}
  <span class="sr-only">
    {steps.filter((step) => step.status === "completed").length} of {steps.length} steps completed
  </span>
{/if}
