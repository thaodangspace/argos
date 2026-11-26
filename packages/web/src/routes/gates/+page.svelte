<script lang="ts">
  /**
   * The gate inbox page (inbox FR3, FR5, FR10): every pending gate of every run, oldest first,
   * decided in place.
   *
   * It reads the shared runs stream and needs no other request: `GET /runs` already carries each
   * run's gates, and the stream replaces the list as soon as anyone decides one — here, in another
   * tab, from the CLI, or by a schedule.
   */
  import { onMount } from "svelte";

  import { createApi } from "#lib/api";
  import ConnectionPill from "#lib/components/ConnectionPill.svelte";
  import GateInbox from "#lib/components/GateInbox.svelte";
  import Toasts from "#lib/components/Toasts.svelte";
  import { gateInbox, type GateInboxEntry } from "#lib/gate-inbox";
  import { runHref } from "#lib/paths";
  import { RunActions } from "#lib/run-actions.svelte";
  import { runsHub } from "#lib/state/runs-hub.svelte";
  import { timeZoneStore } from "#lib/state/timezone.svelte";
  import { ToastStore } from "#lib/state/toasts.svelte";

  const api = createApi();
  // The layout's anchor lease keeps the stream open for the whole app; this route joins it while it
  // is mounted, so the badge and the inbox are one value from one connection (inbox FR6).
  const store = runsHub.store;
  const toasts = new ToastStore();

  let now = $state(Date.now());

  onMount(() => {
    const lease = runsHub.acquire(api);
    return () => {
      lease.release();
    };
  });

  const actions = new RunActions({
    api,
    toasts,
    refresh: () => runsHub.load(),
    navigate: (path) => window.location.assign(path),
    runPath: runHref,
  });

  // The `GateInbox` component projects the same entries for its cards; this copy is the page's count
  // line and the ticker's condition.
  const entries = $derived(
    gateInbox(store.runs, { now, timeZone: timeZoneStore.timeZone, deciding: actions.deciding }),
  );

  const totalLabel = $derived(
    entries.length === 0
      ? "No gate is waiting for a decision."
      : entries.length === 1
        ? "1 gate is waiting for a decision."
        : `${entries.length} gates are waiting for a decision.`,
  );

  // The age labels tick, but only while something waits — an empty inbox renders static (inbox NFR).
  $effect(() => {
    if (entries.length === 0) return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  });

  function decide(
    entry: GateInboxEntry,
    decision: string,
    comment: string | undefined,
  ): Promise<void> {
    return actions.decide(entry.run.id, entry.gate, decision, comment);
  }
</script>

<svelte:head>
  <title>Gates · Argos</title>
</svelte:head>

<section class="head">
  <div>
    <h1>Gates</h1>
    <p class="summary" aria-live="polite">{totalLabel}</p>
  </div>
  <ConnectionPill status={store.status} />
</section>

{#if store.error !== null}
  <div class="banner" role="alert">
    <strong>{store.error.code}</strong>
    <span>{store.error.message}</span>
  </div>
{/if}

<GateInbox
  runs={store.runs}
  {now}
  timeZone={timeZoneStore.timeZone}
  deciding={actions.deciding}
  onDecide={decide}
/>

<Toasts store={toasts} />

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
</style>
