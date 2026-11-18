<script lang="ts">
  import type { Snippet } from "svelte";
  import { shortId, type RunView } from "@thaodangspace/argos-core/view";

  import StatusGlyph from "./StatusGlyph.svelte";

  let { run, actions }: { run: RunView; actions?: Snippet } = $props();
</script>

<header class="run-head">
  <div class="identity">
    <h1>
      {run.playbookId}
      <span class="id">#{run.runIdShort}</span>
    </h1>
    <div class="meta">
      <span class="status tone-{run.tone}">
        <StatusGlyph
          glyph={run.glyph}
          tone={run.tone}
          label={run.statusLabel}
          pulse={run.status === "running"}
        />
        {run.statusLabel}
      </span>
      <span class="dot" aria-hidden="true">·</span>
      <span class="trigger">{run.triggerLabel}</span>
      <span class="dot" aria-hidden="true">·</span>
      <span class="duration">{run.durationLabel}</span>
      {#if run.executor}<span class="badge">{run.executor}</span>{/if}
      {#if run.forkedFrom}
        <span class="badge">
          forked from #{shortId(run.forkedFrom.runId)} @ {run.forkedFrom.stepId}
        </span>
      {/if}
      {#if run.scheduleId}<span class="badge">schedule</span>{/if}
    </div>
    <div class="where">
      <span class="cwd" title={run.cwd}>{run.cwd}</span>
      {#each run.inputs as input (input.name)}
        <span class="input" title={`${input.name}=${input.value}`}>{input.name}={input.value}</span>
      {/each}
      {#if run.worktree}<span class="cwd" title={run.worktree}>worktree {run.worktree}</span>{/if}
      {#if run.usageLabel}<span class="usage">{run.usageLabel}</span>{/if}
    </div>
  </div>
  <div class="actions">
    {@render actions?.()}
  </div>
</header>

<style>
  .run-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }

  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .id {
    color: var(--muted);
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-weight: 400;
  }

  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
    color: var(--muted);
    font-size: 12px;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
  }

  .dot {
    opacity: 0.5;
  }

  .trigger {
    text-transform: capitalize;
  }

  .badge {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }

  .where {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 6px;
    color: var(--muted);
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .cwd {
    max-width: 60ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .input {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .usage {
    font-family: inherit;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .run-head {
      flex-direction: column;
    }
    .actions {
      justify-content: flex-start;
    }
  }
</style>
