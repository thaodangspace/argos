<script lang="ts">
  import type { StepView } from "@thaodangspace/argos-core/view";

  import CopyButton from "./CopyButton.svelte";
  import StatusGlyph from "./StatusGlyph.svelte";

  let { step }: { step: StepView } = $props();
</script>

<section class="log" aria-labelledby="step-log-title">
  <header>
    <h2 id="step-log-title">{step.title}</h2>
    <span class="status tone-{step.tone}">
      <StatusGlyph glyph={step.glyph} tone={step.tone} label={step.statusLabel} />
      {step.statusLabel}
    </span>
    {#if step.durationLabel}<span class="muted">{step.durationLabel}</span>{/if}
    {#if step.usageLabel}<span class="muted">{step.usageLabel}</span>{/if}
    <span class="spacer"></span>
    <CopyButton text={step.logText} label="Copy step log" />
  </header>

  {#if step.attempts.length > 0}
    <div class="attempts">
      {#each step.attempts as attempt (attempt.n)}
        <div class="attempt">
          <span class="attempt-n">#{attempt.n}</span>
          {#if attempt.target}<span class="target">{attempt.target}</span>{/if}
          <span class="muted">{attempt.durationLabel}</span>
          {#if attempt.outcome}
            <span class={attempt.outcome === "completed" ? "tone-success" : "tone-danger"}>
              {attempt.outcome}
            </span>
          {/if}
          {#if attempt.errorCode}<span class="tone-danger">{attempt.errorCode}</span>{/if}
          {#if attempt.usageLabel}<span class="muted">{attempt.usageLabel}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if step.outputs.length > 0}
    <div class="outputs">
      {#each step.outputs as output (output.name)}
        <div class="output">
          <div class="output-name">{output.name}</div>
          <pre>{output.value}</pre>
        </div>
      {/each}
    </div>
  {/if}

  {#if step.log.length > 0}
    <ol class="lines">
      {#each step.log as line, index (index)}
        <li class="tone-{line.tone}">
          <span class="time">{line.timeLabel}</span>
          <span class="text">{line.text}</span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty">No log for this step yet.</p>
  {/if}
</section>

<style>
  .log {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
  }

  .muted {
    color: var(--muted);
    font-size: 12px;
  }

  .spacer {
    flex: 1;
  }

  .attempts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }

  .attempt {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .attempt-n {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .target {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .outputs {
    border-bottom: 1px solid var(--border);
  }

  .output {
    padding: 8px 12px;
  }

  .output + .output {
    border-top: 1px solid var(--border);
  }

  .output-name {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-bottom: 4px;
  }

  pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .lines {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px;
    max-height: 46vh;
    overflow-y: auto;
  }

  .lines li {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 10px;
    padding: 1px 12px;
  }

  .lines li:hover {
    background: var(--surface-hover);
  }

  .time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty {
    margin: 0;
    padding: 16px 12px;
    color: var(--muted);
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .lines li {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .time {
      font-size: 10px;
    }
  }
</style>
