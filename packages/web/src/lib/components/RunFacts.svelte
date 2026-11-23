<script lang="ts">
  /**
   * "Run details" (GitHub Actions' run-page rail): the facts that are not a step — when it started,
   * what triggered it, which project and substrate it used, and what it cost.
   *
   * The run header already shows the live status and the actions; this is the reference block that
   * stays readable while the step log scrolls.
   */
  import type { RunView } from "@thaodangspace/argos-core/view";

  import CopyButton from "./CopyButton.svelte";
  import { workflowHref } from "../paths.js";

  let { run }: { run: RunView } = $props();
</script>

<section class="facts" aria-labelledby="run-details">
  <h2 id="run-details">Run details</h2>
  <dl>
    <dt>Workflow</dt>
    <dd><a href={workflowHref(run.playbookId)}>{run.playbookId}</a></dd>

    <dt>Started</dt>
    <dd>{run.createdLabel}<span class="muted"> · {run.startedRelative}</span></dd>

    <dt>Duration</dt>
    <dd>{run.durationLabel}</dd>

    <dt>Trigger</dt>
    <dd class="trigger">{run.triggerLabel}</dd>

    <dt>Project</dt>
    <dd title={run.cwd}>{run.project}</dd>

    <dt>Executor</dt>
    <dd>{run.executor ?? "paseo"}</dd>

    {#if run.worktree}
      <dt>Worktree</dt>
      <dd class="path" title={run.worktree}>{run.worktree}</dd>
    {/if}

    {#if run.usageLabel}
      <dt>Usage</dt>
      <dd>{run.usageLabel}</dd>
    {/if}

    <dt>Run id</dt>
    <dd class="id">
      <span title={run.id}>{run.runIdShort}</span>
      <CopyButton text={run.id} label="Copy the full run id" />
    </dd>
  </dl>
</section>

<style>
  .facts {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 10px 12px;
    font-size: 12px;
  }

  h2 {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 10px;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a:hover {
    color: var(--accent);
  }

  .trigger {
    text-transform: capitalize;
  }

  .path,
  .id {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .id {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .muted {
    color: var(--muted);
  }
</style>
