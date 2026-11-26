<script lang="ts">
  import { onMount } from "svelte";

  import { pendingGates } from "@thaodangspace/argos-core/view";

  import { createApi } from "#lib/api";
  import GateBadge from "#lib/components/GateBadge.svelte";
  import StartRunDialog from "#lib/components/StartRunDialog.svelte";
  import TimeZoneSelect from "#lib/components/TimeZoneSelect.svelte";
  import { browserStorage } from "#lib/state/hidden-workflows";
  import { runsHub } from "#lib/state/runs-hub.svelte";
  import { ThemeStore } from "#lib/state/theme.svelte";
  import { timeZoneStore } from "#lib/state/timezone.svelte";
  import { href, runHref } from "#lib/paths";
  import "../app.css";

  let { children } = $props();

  const theme = new ThemeStore();
  theme.init();

  // The reader's zone: the browser's own until this browser chooses one (never UTC by default).
  const storage = browserStorage();
  timeZoneStore.init(storage);

  let startOpen = $state(false);

  // The anchor lease (inbox FR6): the layout keeps the shared runs stream open for the whole app,
  // so a route's own lease and the header badge read one value from one SSE connection.
  onMount(() => {
    const lease = runsHub.acquire(createApi());
    return () => {
      lease.release();
    };
  });

  async function started(runId: string): Promise<void> {
    startOpen = false;
    window.location.assign(runHref(runId));
  }
</script>

<a
  class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:border focus:border-surface-200-800 focus:bg-surface-100-900 focus:px-3 focus:py-2"
  href="#main">Skip to content</a
>

<header
  class="flex items-center gap-3 border-b border-surface-200-800 bg-surface-100-900 px-5 py-2.5"
>
  <a class="inline-flex items-center gap-2 font-semibold" href={href("/")}>
    <span
      class="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md bg-primary-500/15 text-[13px] text-primary-700-300"
      aria-hidden="true">⌘</span
    >
    <span>Argos</span>
  </a>
  <span class="flex-1"></span>
  <TimeZoneSelect
    system={timeZoneStore.system}
    value={timeZoneStore.timeZone}
    zones={timeZoneStore.choices}
    onSelect={(zone) => timeZoneStore.select(zone, storage)}
  />
  <!-- The badge reads the same store the anchor lease above keeps open, so its count is live on
       every page. It has no hidden-workflow input (inbox FR9): hiding a row never hides waiting work. -->
  <GateBadge count={pendingGates(runsHub.store.runs).length} />
  <button type="button" class="btn preset-filled-primary-500" onclick={() => (startOpen = true)}
    >Run workflow</button
  >
  <button
    type="button"
    class="btn-icon"
    aria-label={theme.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    title={theme.theme === "dark" ? "Light theme" : "Dark theme"}
    onclick={() => theme.toggle()}
  >
    {theme.theme === "dark" ? "☀" : "☾"}
  </button>
</header>

<main id="main" class="mx-auto max-w-[1080px] p-5">
  {@render children()}
</main>

<StartRunDialog open={startOpen} onClose={() => (startOpen = false)} onStarted={started} />

<footer class="mx-auto max-w-[1080px] px-5 pt-2 pb-6 text-[11px] text-surface-700-300">
  <span>argos serve · 127.0.0.1</span>
</footer>
