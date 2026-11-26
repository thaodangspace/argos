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

<section
  class="card border border-surface-200-800 bg-surface-100-900 px-3 py-2.5 text-[12px]"
  aria-labelledby="run-details"
>
  <h2
    id="run-details"
    class="mt-0 mb-2 text-[11px] font-semibold tracking-[0.04em] text-surface-600-400 uppercase"
  >
    Run details
  </h2>
  <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1">
    <dt class="text-surface-600-400">Workflow</dt>
    <dd class="m-0 truncate">
      <a class="hover:text-primary-700-300" href={workflowHref(run.playbookId)}>{run.playbookId}</a>
    </dd>

    <dt class="text-surface-600-400">Started</dt>
    <dd class="m-0 truncate">
      {run.createdLabel}<span class="text-surface-600-400"> · {run.startedRelative}</span>
    </dd>

    <dt class="text-surface-600-400">Duration</dt>
    <dd class="m-0 truncate tabular-nums">{run.durationLabel}</dd>

    <dt class="text-surface-600-400">Trigger</dt>
    <dd class="m-0 truncate capitalize">{run.triggerLabel}</dd>

    <dt class="text-surface-600-400">Project</dt>
    <dd class="m-0 truncate" title={run.cwd}>{run.project}</dd>

    <dt class="text-surface-600-400">Executor</dt>
    <dd class="m-0 truncate">{run.executor ?? "paseo"}</dd>

    {#if run.worktree}
      <dt class="text-surface-600-400">Worktree</dt>
      <dd class="m-0 truncate font-mono" title={run.worktree}>{run.worktree}</dd>
    {/if}

    {#if run.usageLabel}
      <dt class="text-surface-600-400">Usage</dt>
      <dd class="m-0 truncate tabular-nums">{run.usageLabel}</dd>
    {/if}

    <dt class="text-surface-600-400">Run id</dt>
    <dd class="m-0 flex items-center gap-2 truncate font-mono">
      <span class="truncate" title={run.id}>{run.runIdShort}</span>
      <CopyButton text={run.id} label="Copy the full run id" />
    </dd>
  </dl>
</section>
