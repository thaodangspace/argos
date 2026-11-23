<script lang="ts">
  import type { RunView } from "@thaodangspace/argos-core/view";

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
</script>

<a class="row" href={runHref(run.id)} aria-label={`Run ${run.runIdShort} of ${run.playbookId}: ${run.statusLabel}`}>
  <span class="lead">
    <StatusGlyph glyph={run.glyph} tone={run.tone} label={run.statusLabel} pulse={run.status === "running"} />
  </span>

  <span class="main">
    <span class="title">
      {#if showProject && run.project !== ""}<span class="project">{run.project}</span>{/if}
      {#if showPlaybook}<span class="playbook">{run.playbookId}</span>{/if}
      <span class="detail">{run.detail}</span>
      <span class="id">#{run.runIdShort}</span>
    </span>
    <span class="sub">
      <span class="status tone-{run.tone}">{run.statusLabel}</span>
      <span class="trigger">{run.triggerLabel}</span>
      {#if run.executor}<span class="executor">{run.executor}</span>{/if}
      {#if run.costLabel}<span class="cost">{run.costLabel}</span>{/if}
    </span>
  </span>

  <span class="progress"><ProgressDots steps={run.progress} /></span>

  <span class="times">
    <span class="duration">{run.durationLabel}</span>
    <span class="relative" title={relativeTitle}>{relativeLabel}</span>
  </span>
</a>

<style>
  .row {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    color: var(--text);
  }

  .row:hover {
    background: var(--surface-hover);
  }

  .lead {
    display: flex;
    justify-content: center;
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .playbook {
    font-weight: 600;
    white-space: nowrap;
  }

  .project {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .detail {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .id {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px;
    white-space: nowrap;
  }

  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
  }

  .trigger {
    text-transform: capitalize;
  }

  .executor {
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .progress {
    display: flex;
    align-items: center;
  }

  .times {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    min-width: 88px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .duration {
    color: var(--text);
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: 20px minmax(0, 1fr);
    }
    .progress,
    .times {
      grid-column: 2;
      flex-direction: row;
      justify-content: flex-start;
      gap: 8px;
      min-width: 0;
    }
  }
</style>
