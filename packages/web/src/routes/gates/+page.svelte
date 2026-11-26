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
  import { gateInbox, type GateInboxEntry } from "#lib/gate-inbox";
  import { runHref } from "#lib/paths";
  import { TONE_TEXT, toneClass } from "#lib/ui/tone";
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

  // Before the first read an empty inbox is unknown, not an all-clear, so the count line says so.
  const totalLabel = $derived(
    !store.loaded
      ? "Loading gates…"
      : entries.length === 0
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

<header class="mb-3.5 flex items-center justify-between gap-4">
  <div>
    <h1 class="m-0 text-xl font-semibold">Gates</h1>
    <p class="mt-0.5 text-[13px] text-surface-600-400" aria-live="polite">{totalLabel}</p>
  </div>
  <ConnectionPill status={store.status} />
</header>

{#if store.error !== null}
  <div
    class="mb-3.5 flex flex-wrap items-center gap-2 rounded-lg border border-error-500/40 bg-error-500/15 p-3 text-[13px]"
    role="alert"
  >
    <strong class={["font-mono", toneClass(TONE_TEXT, "danger")]} data-tone="danger"
      >{store.error.code}</strong
    >
    <span>{store.error.message}</span>
  </div>
{/if}

<GateInbox
  runs={store.runs}
  loaded={store.loaded}
  {now}
  timeZone={timeZoneStore.timeZone}
  deciding={actions.deciding}
  onDecide={decide}
/>
