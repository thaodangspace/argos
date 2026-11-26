<script lang="ts">
  import { onMount } from "svelte";

  import {
    buildRunLog,
    isActiveRun,
    runView,
    type GateView,
    type RunView,
  } from "@thaodangspace/argos-core/view";

  import { createApi, toApiError } from "#lib/api";
  import EmptyState from "#lib/components/EmptyState.svelte";
  import GateCard from "#lib/components/GateCard.svelte";
  import RunFacts from "#lib/components/RunFacts.svelte";
  import RunGraph from "#lib/components/RunGraph.svelte";
  import RunHeader from "#lib/components/RunHeader.svelte";
  import RunLog from "#lib/components/RunLog.svelte";
  import StepLog from "#lib/components/StepLog.svelte";
  import StepRail from "#lib/components/StepRail.svelte";
  import StartRunDialog from "#lib/components/StartRunDialog.svelte";
  import Toasts from "#lib/components/Toasts.svelte";
  import ViewToggle from "#lib/components/ViewToggle.svelte";
  import { href, runHref, workflowHref } from "#lib/paths";
  import { RunActions } from "#lib/run-actions.svelte";
  import { DetailStore } from "#lib/state/detail.svelte";
  import { runsHub } from "#lib/state/runs-hub.svelte";
  import { timeZoneStore } from "#lib/state/timezone.svelte";
  import { ToastStore } from "#lib/state/toasts.svelte";
  import {
    readViewParams,
    writeViewParams,
    type RunViewMode,
  } from "#lib/view-query";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const api = createApi();
  // The shared stream (inbox FR6): the layout holds the anchor lease and this route joins it.
  const list = runsHub.store;
  const detail = new DetailStore();
  const toasts = new ToastStore();

  let now = $state(Date.now());
  let selectedStepId = $state<string | null>(null);
  let viewMode = $state<RunViewMode>("rail");
  let startOpen = $state(false);

  const graph = $derived(detail.detail?.id === data.runId ? detail.detail.graph : undefined);
  // `?view=graph` against a detail without a graph (an older server) falls back to the rail.
  const showGraph = $derived(viewMode === "graph" && graph !== undefined);

  onMount(() => {
    const lease = runsHub.acquire(api);
    void detail.open(api, data.runId);
    const initial = readViewParams(window.location.search);
    selectedStepId = initial.step;
    viewMode = initial.view;

    const onPop = (): void => {
      const params = readViewParams(window.location.search);
      selectedStepId = params.step;
      viewMode = params.view;
    };
    window.addEventListener("popstate", onPop);

    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (event.key !== "j" && event.key !== "k") return;
      const steps = run?.steps ?? [];
      if (steps.length === 0) return;
      const index = steps.findIndex((step) => step.id === currentStep?.id);
      const next = event.key === "j" ? index + 1 : index - 1;
      const step = steps[Math.max(0, Math.min(steps.length - 1, next))];
      if (step !== undefined) selectStep(step.id);
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      // Bump the detail token before dropping the lease: a `GET /runs/:id` that resolves after
      // navigation is dropped instead of writing into a page that is gone.
      detail.close();
      lease.release();
    };
  });

  const summary = $derived(
    list.runs.find((entry) => entry.id === data.runId) ??
      (detail.detail?.id === data.runId ? detail.detail : undefined),
  );

  const run: RunView | null = $derived(
    summary === undefined
      ? null
      : runView(summary, {
          ...(detail.detail?.id === data.runId ? { detail: detail.detail } : {}),
          now,
          timeZone: timeZoneStore.timeZone,
        }),
  );

  const runLog = $derived(
    run === null
      ? []
      : buildRunLog(detail.detail?.history ?? [], { timeZone: timeZoneStore.timeZone }),
  );

  // A summary frame is the trigger to re-read the detail only when its `seq` moved.
  $effect(() => {
    const entry = list.runs.find((candidate) => candidate.id === data.runId);
    if (entry === undefined) return;
    void detail.refreshIfMoved(api, entry.id, entry.seq);
  });

  // Elapsed times tick only while this run is live.
  $effect(() => {
    if (run === null || !isActiveRun(run.status)) return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  });

  const currentStep = $derived(
    run === null
      ? null
      : (run.steps.find((step) => step.id === selectedStepId) ??
        run.steps.find((step) => step.status === "running") ??
        run.steps[0] ??
        null),
  );

  const pendingGates = $derived(
    run === null ? [] : run.gates.filter((gate) => gate.status === "pending"),
  );

  function selectStep(stepId: string): void {
    selectedStepId = stepId;
    if (typeof window === "undefined") return;
    commitView(showGraph ? "graph" : "rail", stepId);
  }

  function setView(view: RunViewMode): void {
    if (view === "graph" && graph === undefined) return;
    viewMode = view;
    if (typeof window === "undefined") return;
    commitView(view, selectedStepId);
  }

  /** One `replaceState` for both parameters, so `?view=` and `?step=` never fight (FR17). */
  function commitView(view: RunViewMode, step: string | null): void {
    const url = writeViewParams(new URL(window.location.href), { view, step });
    window.history.replaceState(window.history.state, "", url);
  }

  async function refresh(): Promise<void> {
    await runsHub.load();
    await detail.open(api, data.runId);
  }

  const actions = new RunActions({
    api,
    toasts,
    refresh,
    navigate: (path) => window.location.assign(path),
    runPath: runHref,
  });
</script>

<svelte:head>
  <title>{run === null ? "Run" : `${run.playbookId} #${run.runIdShort}`} · Argos</title>
</svelte:head>

{#snippet headerActions()}
  {#if run !== null}
    <button
      type="button"
      class="action"
      class:confirm={actions.confirmingCancel}
      disabled={!run.active || actions.busy}
      onclick={() => actions.cancel(data.runId)}
    >
      {actions.confirmingCancel ? "Confirm cancel" : "Cancel run"}
    </button>
    {#if !run.active && currentStep !== null}
      {#if currentStep.retryable}
        <button type="button" class="action" disabled={actions.busy} onclick={() => actions.retry(data.runId, currentStep)}>Retry step</button>
      {/if}
      <button type="button" class="action" disabled={actions.busy} onclick={() => actions.fork(data.runId, currentStep)}>Fork from step</button>
    {/if}
    <button type="button" class="action" onclick={() => (startOpen = true)}>Start similar</button>
  {/if}
{/snippet}

{#if run === null}
  {#if detail.error?.code === "run_unknown"}
    <EmptyState
      title="Run not found"
      hint="It may have been removed from Argos. Go back to the workflow list to pick another run."
    />
    <p class="back"><a href={href("/")}>← All workflows</a></p>
  {:else if detail.error !== null}
    <div class="banner" role="alert">
      <strong>{detail.error.code}</strong>
      <span>{detail.error.message}</span>
    </div>
    <p class="back"><a href={href("/")}>← All workflows</a></p>
  {:else}
    <div class="loading" aria-busy="true">Loading run…</div>
  {/if}
{:else}
  <p class="back">
    <a href={workflowHref(run.playbookId)}>← {run.playbookId}</a>
    <span class="sep" aria-hidden="true">·</span>
    <a href={href("/")}>All workflows</a>
  </p>

  <RunHeader {run} actions={headerActions} />

  <div class="viewbar">
    <ViewToggle view={showGraph ? "graph" : "rail"} graphAvailable={graph !== undefined} onView={setView} />
  </div>

  {#if pendingGates.length > 0}
    <section class="gates" aria-label="Pending gates">
      {#each pendingGates as gate (gate.key)}
        <GateCard
          {gate}
          busy={actions.deciding.includes(gate.key)}
          onDecide={(decision, comment) => actions.decide(data.runId, gate, decision, comment)}
        />
      {/each}
    </section>
  {/if}

  {#if showGraph && graph !== undefined}
    <div class="graph-pane">
      <RunGraph
        graph={graph}
        steps={run.steps}
        selectedId={currentStep?.id ?? null}
        onSelect={selectStep}
      />
      <RunFacts {run} />
    </div>
    <div class="pane">
      {#if currentStep !== null}
        <StepLog step={currentStep} />
      {:else}
        <EmptyState title="No steps" hint="This run has no steps to show." />
      {/if}
      <RunLog entries={runLog} />
    </div>
  {:else}
    <div class="layout">
      <div class="side">
        <StepRail steps={run.steps} selectedId={currentStep?.id ?? null} onSelect={selectStep} />
        <RunFacts {run} />
      </div>
      <div class="pane">
        {#if currentStep !== null}
          <StepLog step={currentStep} />
        {:else}
          <EmptyState title="No steps" hint="This run has no steps to show." />
        {/if}
        <RunLog entries={runLog} />
      </div>
    </div>
  {/if}

  <StartRunDialog
    open={startOpen}
    onClose={() => (startOpen = false)}
    onStarted={async (runId) => {
      startOpen = false;
      window.location.assign(runHref(runId));
    }}
    initial={{
      cwd: run.cwd,
      playbookId: run.playbookId,
      inputs: Object.fromEntries(run.inputs.map((input) => [input.name, input.value])),
    }}
  />
{/if}

<Toasts store={toasts} />

<style>
  .back {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);
  }

  .back a:hover {
    color: var(--text);
  }

  .sep {
    opacity: 0.5;
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .pane {
    min-width: 0;
  }

  .viewbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 10px;
  }

  .graph-pane {
    min-width: 0;
    margin-bottom: 14px;
  }

  .banner {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: 6px;
    background: var(--danger-soft);
    font-size: 13px;
  }

  .banner strong {
    color: var(--danger);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .action {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }

  .action:hover:not(:disabled) {
    background: var(--surface-hover);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .confirm {
    border-color: var(--danger);
    color: var(--danger);
    background: var(--danger-soft);
  }

  .gates {
    margin-bottom: 4px;
  }

  .loading {
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }

  @media (max-width: 860px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .layout :global(.rail) {
      position: static;
      max-height: none;
    }
  }
</style>
