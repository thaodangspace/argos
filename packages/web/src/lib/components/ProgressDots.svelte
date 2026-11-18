<script lang="ts">
  import type { StepProgressView } from "@thaodangspace/argos-core/view";

  let { steps }: { steps: readonly StepProgressView[] } = $props();
</script>

<span class="dots" aria-hidden="true">
  {#each steps as step (step.id)}
    <span class="dot bg-{step.tone}" title={`${step.label}: ${step.status}`}></span>
  {/each}
</span>
{#if steps.length > 0}
  <span class="sr-only">
    {steps.filter((step) => step.status === "completed").length} of {steps.length} steps completed
  </span>
{/if}

<style>
  .dots {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    opacity: 0.85;
  }
</style>
