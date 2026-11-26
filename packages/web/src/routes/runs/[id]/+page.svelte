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
  import ViewToggle from "#lib/components/ViewToggle.svelte";
  import { href, runHref, workflowHref } from "#lib/paths";
  import { TONE_TEXT, toneClass } from "#lib/ui/tone";
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
      class={actions.confirmingCancel
        ? "btn btn-sm preset-filled-error-500 disabled:cursor-not-allowed disabled:opacity-50"
        : "btn btn-sm preset-tonal disabled:cursor-not-allowed disabled:opacity-50"}
      disabled={!run.active || actions.busy}
      onclick={() => actions.cancel(data.runId)}
    >
      {actions.confirmingCancel ? "Confirm cancel" : "Cancel run"}
    </button>
    {#if !run.active && currentStep !== null}
      {#if currentStep.retryable}
        <button
          type="button"
          class="btn btn-sm preset-tonal disabled:cursor-not-allowed disabled:opacity-50"
          disabled={actions.busy}
          onclick={() => actions.retry(data.runId, currentStep)}>Retry step</button
        >
      {/if}
      <button
        type="button"
        class="btn btn-sm preset-tonal disabled:cursor-not-allowed disabled:opacity-50"
        disabled={actions.busy}
        onclick={() => actions.fork(data.runId, currentStep)}>Fork from step</button
      >
    {/if}
    <button type="button" class="btn btn-sm preset-tonal" onclick={() => (startOpen = true)}
      >Start similar</button
    >
  {/if}
{/snippet}

{#if run === null}
  {#if detail.error?.code === "run_unknown"}
    <EmptyState
      title="Run not found"
      hint="It may have been removed from Argos. Go back to the workflow list to pick another run."
    />
    <p class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-surface-600-400">
      <a class="hover:text-surface-950-50" href={href("/")}>← All workflows</a>
    </p>
  {:else if detail.error !== null}
    <div
      class="mb-3.5 flex flex-wrap items-center gap-2 rounded-lg border border-error-500/40 bg-error-500/15 p-3 text-[13px]"
      role="alert"
    >
      <strong class={["font-mono", toneClass(TONE_TEXT, "danger")]} data-tone="danger"
        >{detail.error.code}</strong
      >
      <span>{detail.error.message}</span>
    </div>
    <p class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-surface-600-400">
      <a class="hover:text-surface-950-50" href={href("/")}>← All workflows</a>
    </p>
  {:else}
    <div class="p-8 text-center text-surface-600-400" aria-busy="true">Loading run…</div>
  {/if}
{:else}
  <p class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px] text-surface-600-400">
    <a class="hover:text-surface-950-50" href={workflowHref(run.playbookId)}>← {run.playbookId}</a>
    <span class="opacity-50" aria-hidden="true">·</span>
    <a class="hover:text-surface-950-50" href={href("/")}>All workflows</a>
  </p>

  <RunHeader {run} actions={headerActions} />

  <div class="mb-2.5 flex justify-end">
    <ViewToggle
      view={showGraph ? "graph" : "rail"}
      graphAvailable={graph !== undefined}
      onView={setView}
    />
  </div>

  {#if pendingGates.length > 0}
    <section class="mb-1" aria-label="Pending gates">
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
    <div class="mb-3.5 min-w-0">
      <RunGraph
        graph={graph}
        steps={run.steps}
        selectedId={currentStep?.id ?? null}
        onSelect={selectStep}
      />
      <RunFacts {run} />
    </div>
    <div class="min-w-0">
      {#if currentStep !== null}
        <StepLog step={currentStep} />
      {:else}
        <EmptyState title="No steps" hint="This run has no steps to show." />
      {/if}
      <RunLog entries={runLog} />
    </div>
  {:else}
    <div class="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div class="flex min-w-0 flex-col gap-3">
        <StepRail steps={run.steps} selectedId={currentStep?.id ?? null} onSelect={selectStep} />
        <RunFacts {run} />
      </div>
      <div class="min-w-0">
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
