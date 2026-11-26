<script lang="ts">
  import { onMount } from "svelte";

  import { Toast } from "@skeletonlabs/skeleton-svelte";
  import { pendingGates } from "@thaodangspace/argos-core/view";

  import { createApi } from "#lib/api";
  import GateBadge from "#lib/components/GateBadge.svelte";
  import StartRunDialog from "#lib/components/StartRunDialog.svelte";
  import TimeZoneSelect from "#lib/components/TimeZoneSelect.svelte";
  import { browserStorage } from "#lib/state/hidden-workflows";
  import { runsHub } from "#lib/state/runs-hub.svelte";
  import { ThemeStore } from "#lib/state/theme.svelte";
  import { timeZoneStore } from "#lib/state/timezone.svelte";
  import { toaster, type ToastTone } from "#lib/state/toasts.svelte";
  import { href, runHref } from "#lib/paths";
  import "../app.css";

  let { children } = $props();

  const theme = new ThemeStore();
  theme.init();

  // The reader's zone: the browser's own until this browser chooses one (never UTC by default).
  const storage = browserStorage();
  timeZoneStore.init(storage);

  let startOpen = $state(false);

  // One literal per tone (spec FR4): the toaster's type is Zag's word, ours is the same three.
  const TOAST_SURFACE: Readonly<Record<ToastTone, string>> = {
    info: "border-surface-200-800 bg-surface-100-900",
    success: "border-success-500/40 bg-success-500/15",
    error: "border-error-500/40 bg-error-500/15",
  };

  function toastSurface(type: string | undefined): string {
    return TOAST_SURFACE[type === "error" || type === "success" ? type : "info"];
  }

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

<!-- The document-wide toasts (spec FR12): one `Toast.Group` fed by `state/toasts.svelte.ts`, so a
     page keeps its own `ToastStore` and the rendering exists once, here. Zag supplies positioning,
     the live region (`role="status"`), the dismiss key/Escape handling and the TTL animation; the
     colours and spacing are utilities. -->
<Toast.Group {toaster}>
  {#snippet children(toast)}
    <Toast
      {toast}
      class={[
        "card mt-2 flex items-start gap-2 border p-2.5 text-[13px] shadow-lg",
        toastSurface(toast.type),
      ]}
    >
      <Toast.Title class="min-w-0 flex-1 text-surface-950-50 [overflow-wrap:anywhere]">
        {toast.title}
      </Toast.Title>
      {#if typeof toast.description === "string" && toast.description !== ""}
        <Toast.Description class="badge preset-tonal-error shrink-0 font-mono whitespace-nowrap">
          {toast.description}
        </Toast.Description>
      {/if}
      <Toast.CloseTrigger class="btn-icon btn-icon-sm shrink-0"
        ><span aria-hidden="true">×</span></Toast.CloseTrigger
      >
    </Toast>
  {/snippet}
</Toast.Group>

<footer class="mx-auto max-w-[1080px] px-5 pt-2 pb-6 text-[11px] text-surface-700-300">
  <span>argos serve · 127.0.0.1</span>
</footer>
