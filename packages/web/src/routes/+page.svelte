<script lang="ts">
  import { onMount } from "svelte";

  import {
    isActiveRun,
    panelView,
    pendingGates,
    type RunFilter,
  } from "@thaodangspace/argos-core/view";

  import { createApi } from "#lib/api";
  import ConnectionPill from "#lib/components/ConnectionPill.svelte";
  import EmptyState from "#lib/components/EmptyState.svelte";
  import FilterChips from "#lib/components/FilterChips.svelte";
  import RunGroup from "#lib/components/RunGroup.svelte";
  import { RunsStore } from "#lib/state/runs.svelte";

  const api = createApi();
  const store = new RunsStore();

  let now = $state(Date.now());

  onMount(() => {
    store.start(api);
    return () => {
      store.stop();
    };
  });

  // Elapsed times tick only while something is running; a finished list renders static.
  $effect(() => {
    const active = store.runs.some((run) => isActiveRun(run.status));
    if (!active) return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  });

  const view = $derived(
    panelView(
      {
        runs: store.runs,
        gates: pendingGates(store.runs),
        inFlight: [],
        busyRuns: [],
        detail: null,
        selectedRunId: null,
        detailLoading: false,
        filter: store.filter,
        loading: store.loading,
        connected: store.status === "open",
        error: store.error,
      },
      { now },
    ),
  );

  function selectFilter(filter: RunFilter): void {
    store.filter = filter;
  }
</script>

<svelte:head>
  <title>Argos · Workflows</title>
</svelte:head>

<section class="head">
  <div>
    <h1>Workflows</h1>
    <p class="summary" aria-live="polite">{view.heading}</p>
  </div>
  <ConnectionPill status={store.status} />
</section>

{#if store.error !== null}
  <div class="banner" role="alert">
    <strong>{store.error.code}</strong>
    <span>{store.error.message}</span>
    {#if store.error.code === "unreachable" || store.error.code === "unauthorized"}
      <span class="hint">Start the server with <code>argos serve</code>, then reload.</span>
    {/if}
  </div>
{/if}

<div class="toolbar">
  <FilterChips filters={view.filters} active={view.filter} onSelect={selectFilter} />
</div>

{#if view.groups.length > 0}
  {#each view.groups as group (group.playbookId)}
    <RunGroup {group} />
  {/each}
{:else if view.loading || !store.loaded}
  <div class="loading" aria-busy="true">Loading runs…</div>
{:else if view.filter !== "all" && view.runs.length > 0}
  <EmptyState
    title={`No ${view.filter} runs`}
    hint="Clear the filter to see the other runs of this server."
  />
{:else}
  <EmptyState
    title="No workflow runs yet"
    hint="Start one from the CLI with `argos run <playbook>`, or wait for a schedule to fire. Runs appear here live."
  />
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .summary {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .toolbar {
    margin-bottom: 14px;
  }

  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: 6px;
    background: var(--danger-soft);
    font-size: 13px;
  }

  .banner strong {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    color: var(--danger);
  }

  .hint {
    color: var(--muted);
  }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--neutral-soft);
  }

  .loading {
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }
</style>
