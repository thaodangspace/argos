<script lang="ts">
  import type { StepView } from "@thaodangspace/argos-core/view";

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
</script>

<nav class="rail" aria-label="Steps">
  {#each steps as step (step.id)}
    <button
      type="button"
      class="step"
      class:selected={step.id === selectedId}
      aria-current={step.id === selectedId ? "step" : undefined}
      onclick={() => onSelect(step.id)}
    >
      <span class="glyph">
        <StatusGlyph
          glyph={step.glyph}
          tone={step.tone}
          label={step.statusLabel}
          pulse={step.status === "running"}
        />
      </span>
      <span class="body">
        <span class="title">{step.title}</span>
        <span class="sub">
          <span class="tone-{step.tone}">{step.statusLabel}</span>
          <span class="kind">{step.kindLabel}</span>
          {#if step.attemptCount > 1}<span class="kind">{step.attemptCount} attempts</span>{/if}
          {#if step.durationLabel}<span class="kind">{step.durationLabel}</span>{/if}
          {#if pendingGates(step) > 0}
            <span class="gate">{pendingGates(step)} pending</span>
          {/if}
        </span>
      </span>
    </button>
  {/each}
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
    align-self: start;
    position: sticky;
    top: 12px;
    max-height: calc(100vh - 140px);
    overflow-y: auto;
  }

  .step {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 8px 10px;
    border: 0;
    border-left: 3px solid transparent;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: var(--text);
  }

  .step:hover {
    background: var(--surface-hover);
  }

  .selected {
    background: var(--accent-soft);
    border-left-color: var(--accent);
  }

  .glyph {
    padding-top: 1px;
  }

  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 1px;
    color: var(--muted);
    font-size: 11px;
  }

  .kind {
    opacity: 0.85;
  }

  .gate {
    color: var(--warning);
  }
</style>
