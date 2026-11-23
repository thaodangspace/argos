<script lang="ts">
  /**
   * The run list (spec FR8/FR11): GitHub-Actions shaped. Time is the axis — one chronological list
   * with day sections — and project/workflow/trigger/executor are facets in the rail, the toolbar and
   * the address bar. Grouping by workflow is still available on the Paseo panel, which renders the
   * mobile-native CI view; this page answers "which workflow ran before which".
   */
  import { onMount } from "svelte";

  import {
    isActiveRun,
    panelView,
    pendingGates,
    scopeSubtitle,
    scopeTitle,
    type RunFilter,
    type RunSort,
  } from "@thaodangspace/argos-core/view";

  import { createApi } from "#lib/api";
  import ConnectionPill from "#lib/components/ConnectionPill.svelte";
  import EmptyState from "#lib/components/EmptyState.svelte";
  import ListToolbar from "#lib/components/ListToolbar.svelte";
  import RunList from "#lib/components/RunList.svelte";
  import WorkflowRail from "#lib/components/WorkflowRail.svelte";
  import {
    DEFAULT_LIST_STATE,
    listStateToSearch,
    mergeListState,
    parseListState,
    type ListState,
    type ListStatePatch,
  } from "#lib/list-query";
  import {
    browserStorage,
    readHidden,
    toggleHidden,
    writeHidden,
  } from "#lib/state/hidden-workflows";
  import { RunsStore } from "#lib/state/runs.svelte";
  import { timeZoneStore } from "#lib/state/timezone.svelte";

  const api = createApi();
  const store = new RunsStore();
  const storage = browserStorage();

  let now = $state(Date.now());
  let list = $state<ListState>(DEFAULT_LIST_STATE);
  /** Workflows with an enabled schedule: the rail reads "in use" from these plus live runs. */
  let liveWorkflows = $state<string[]>([]);
  /** Workflows hidden from the rail in this browser (a view preference, never server state). */
  let hidden = $state<string[]>([]);

  function readSearch(): ListState {
    if (typeof window === "undefined") return DEFAULT_LIST_STATE;
    return parseListState(window.location.search);
  }

  /** Write the filter state into the address bar without a navigation (the list is one page). */
  function syncSearch(next: ListState): void {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.search = listStateToSearch(next);
    window.history.replaceState(window.history.state, "", url);
  }

  function apply(patch: ListStatePatch): void {
    const next = mergeListState(list, patch);
    list = next;
    syncSearch(next);
  }

  /**
   * The rail's "in use" half. A schedule roster failure is not an error: the rail then falls back to
   * live runs only, exactly as for a server too old to have schedules.
   */
  async function loadSchedules(): Promise<void> {
    try {
      const schedules = await api.listSchedules();
      liveWorkflows = schedules.filter((schedule) => schedule.enabled).map((s) => s.playbookId);
    } catch {
      liveWorkflows = [];
    }
  }

  function hideWorkflow(workflowId: string): void {
    hidden = toggleHidden(hidden, workflowId);
    writeHidden(storage, hidden);
  }

  function showHidden(): void {
    hidden = [];
    writeHidden(storage, hidden);
  }

  onMount(() => {
    list = readSearch();
    hidden = readHidden(storage);
    void loadSchedules();
    store.start(api);
    const onPop = (): void => {
      list = readSearch();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
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
        filter: list.status,
        sort: list.sort,
        loading: store.loading,
        connected: store.status === "open",
        error: store.error,
        ...(list.project === undefined ? {} : { project: list.project }),
        ...(list.workflow === undefined ? {} : { workflow: list.workflow }),
        ...(list.trigger === undefined ? {} : { trigger: list.trigger }),
        ...(list.executor === undefined ? {} : { executor: list.executor }),
        liveWorkflows,
      },
      { now, timeZone: timeZoneStore.timeZone },
    ),
  );

  const filtered = $derived(
    list.status !== "all" ||
      list.project !== undefined ||
      list.workflow !== undefined ||
      list.trigger !== undefined ||
      list.executor !== undefined,
  );

  function selectStatus(status: RunFilter): void {
    apply({ status });
  }

  function selectSort(sort: RunSort): void {
    apply({ sort });
  }

  function selectFacet(
    facet: "project" | "workflow" | "trigger" | "executor",
    value: string | undefined,
  ): void {
    switch (facet) {
      case "project":
        apply({ project: value });
        return;
      case "workflow":
        apply({ workflow: value });
        return;
      case "trigger":
        apply({ trigger: value as ListState["trigger"] });
        return;
      case "executor":
        apply({ executor: value });
    }
  }

  function selectScope(scope: { workflow?: string | undefined; project?: string | undefined }): void {
    apply({ workflow: scope.workflow, project: scope.project });
  }

  function clearFilters(): void {
    apply({ status: "all", project: undefined, workflow: undefined, trigger: undefined, executor: undefined });
  }
</script>

<svelte:head>
  <title>{scopeTitle(view.query)} · Argos</title>
</svelte:head>

<section class="head">
  <div>
    <h1>{scopeTitle(view.query)}</h1>
    <p class="summary" aria-live="polite">{scopeSubtitle(view.query, view.visibleCount)}</p>
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

<div class="layout">
  <aside class="side">
    <WorkflowRail
      facets={view.facets}
      query={view.query}
      total={view.runs.length}
      {hidden}
      onSelect={selectScope}
      onHide={hideWorkflow}
      onShowHidden={showHidden}
    />
  </aside>

  <div class="main">
    <ListToolbar
      filters={view.filters}
      query={view.query}
      facets={view.facets}
      sort={view.sort}
      total={view.visibleCount}
      running={view.filters.find((filter) => filter.id === "running")?.count ?? 0}
      onStatus={selectStatus}
      onFacet={selectFacet}
      onSort={selectSort}
    />

    {#if view.list.length > 0}
      <RunList
        days={view.days}
        relative={view.sort === "activity" ? "activity" : "start"}
        showPlaybook={view.query.workflow === undefined}
        showProject={view.facets.projects.length > 1}
      />
    {:else if view.loading || !store.loaded}
      <div class="loading" aria-busy="true">Loading runs…</div>
    {:else if filtered && view.runs.length > 0}
      <EmptyState
        title="No runs match this scope"
        hint="No run of this server is in the selected workflow, project, trigger, or status."
      />
      <p class="clear">
        <button type="button" onclick={clearFilters}>Clear filters</button>
      </p>
    {:else}
      <EmptyState
        title="No workflow runs yet"
        hint="Start one from the CLI with `argos run <playbook>`, or wait for a schedule to fire. Runs appear here live."
      />
    {/if}
  </div>
</div>

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
    overflow-wrap: anywhere;
  }

  .summary {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(170px, 210px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .main {
    min-width: 0;
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

  .clear {
    margin: 10px 0 0;
  }

  .clear button {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }

  .clear button:hover {
    background: var(--surface-hover);
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      display: none;
    }
  }
</style>
