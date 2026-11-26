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

<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <a class="brand" href={href("/")}>
    <span class="mark" aria-hidden="true">⌘</span>
    <span class="name">Argos</span>
  </a>
  <span class="spacer"></span>
  <TimeZoneSelect
    system={timeZoneStore.system}
    value={timeZoneStore.timeZone}
    zones={timeZoneStore.choices}
    onSelect={(zone) => timeZoneStore.select(zone, storage)}
  />
  <!-- The badge reads the same store the anchor lease above keeps open, so its count is live on
       every page. It has no hidden-workflow input (inbox FR9): hiding a row never hides waiting work. -->
  <GateBadge count={pendingGates(runsHub.store.runs).length} />
  <button type="button" class="cta" onclick={() => (startOpen = true)}>Run workflow</button>
  <button
    type="button"
    class="icon"
    aria-label={theme.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    title={theme.theme === "dark" ? "Light theme" : "Dark theme"}
    onclick={() => theme.toggle()}
  >
    {theme.theme === "dark" ? "☀" : "☾"}
  </button>
</header>

<main id="main">
  {@render children()}
</main>

<StartRunDialog open={startOpen} onClose={() => (startOpen = false)} onStarted={started} />

<footer>
  <span>argos serve · 127.0.0.1</span>
</footer>

<style>
  .skip {
    position: absolute;
    left: -9999px;
    top: 0;
    padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    z-index: 10;
  }

  .skip:focus {
    left: 8px;
    top: 8px;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 13px;
  }

  .spacer {
    flex: 1;
  }

  .icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    line-height: 1;
  }

  .cta {
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid var(--success);
    background: var(--success);
    color: #04130a;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .cta:hover {
    filter: brightness(1.05);
  }

  .icon:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 20px;
  }

  footer {
    max-width: 1080px;
    margin: 0 auto;
    padding: 8px 20px 24px;
    color: var(--muted);
    font-size: 11px;
  }
</style>
