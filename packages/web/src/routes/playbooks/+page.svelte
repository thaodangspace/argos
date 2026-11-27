<script lang="ts">
  /**
   * The playbook editor screen (editor FR20–FR25): one repository scope, a rail of its discovered
   * playbooks, and the editor for the selected file.
   *
   * The scope lives in the URL (`?cwd=&file=`) exactly as the list's filters do, so a link reopens the
   * same file and the back button steps through the selections. The page owns the listing, the scope,
   * and the dirty guard; `PlaybookEditor` owns the buffer.
   *
   * A missing `cwd` is not an error: the server answers for its own working directory (`GET
   * /playbooks` with no parameter echoes it back), and when even that is unavailable the page shows
   * the empty state rather than a failure.
   */
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";

  import type { PlaybookListResponse } from "@thaodangspace/argos-core/rpc/contracts";

  import { createApi, toApiError } from "#lib/api";
  import EmptyState from "#lib/components/EmptyState.svelte";
  import PlaybookEditor from "#lib/components/PlaybookEditor.svelte";
  import PlaybookRail from "#lib/components/PlaybookRail.svelte";
  import {
    EMPTY_PLAYBOOK_SELECTION,
    parsePlaybookQuery,
    playbookQueryToSearch,
    type PlaybookSelection,
  } from "#lib/playbook-query";
  import { addRecent, readRecents, writeRecents } from "#lib/state/recents";
  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  const api = createApi();
  const DISCARD = "Discard the unsaved changes to this playbook?";

  // Read once at init rather than in `onMount`: the listing effect below would otherwise ask twice
  // (once for the empty selection, once for the URL's scope). `readSelection` guards `window`, so a
  // build and a jsdom render both work.
  let selection = $state<PlaybookSelection>(readSelection());
  /** The server's own directory, used only when the URL names none (editor FR21). */
  let serverCwd = $state<string | null>(null);
  let listing = $state<PlaybookListResponse | null>(null);
  let listingLoading = $state(false);
  let listingError = $state<{ code: string; message: string } | null>(null);
  let suggestions = $state<string[]>([]);
  let cwdInput = $state("");
  let dirty = $state(false);
  let listingToken = 0;

  const effectiveCwd = $derived(selection.cwd ?? serverCwd);

  function readSelection(): PlaybookSelection {
    if (typeof window === "undefined") return EMPTY_PLAYBOOK_SELECTION;
    return parsePlaybookQuery(window.location.search);
  }

  /** The address bar is the selection's home: written without a navigation, re-read on `popstate`. */
  function applySelection(next: PlaybookSelection): void {
    selection = next;
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.search = playbookQueryToSearch(next);
    window.history.replaceState(window.history.state, "", url);
  }

  function confirmDiscard(): boolean {
    if (!dirty || typeof window === "undefined") return true;
    return window.confirm(DISCARD);
  }

  async function loadListing(scope: string | null): Promise<void> {
    const token = ++listingToken;
    listingLoading = true;
    listingError = null;
    try {
      const response = await api.listPlaybooks(scope ?? undefined);
      if (token !== listingToken) return;
      listing = response;
      if (scope === null) {
        serverCwd = response.cwd;
        if (selection.cwd === null && cwdInput.trim() === "") cwdInput = response.cwd;
      }
    } catch (error) {
      if (token !== listingToken) return;
      const failure = toApiError(error);
      listingError = { code: failure.code, message: failure.message };
      listing = null;
    } finally {
      if (token === listingToken) listingLoading = false;
    }
  }

  function rememberCwd(cwd: string): void {
    suggestions = addRecent(suggestions, cwd);
    writeRecents(suggestions);
  }

  function submitScope(event: SubmitEvent): void {
    event.preventDefault();
    const value = cwdInput.trim();
    if (value === "") return;
    if (!confirmDiscard()) return;
    applySelection({ cwd: value, file: null });
    rememberCwd(value);
  }

  function openFile(file: string): void {
    select({ cwd: effectiveCwd, file });
  }

  /** Drop the file and keep the repository: the same dirty guard, and no navigation (FR24). */
  function closeFile(): void {
    select({ cwd: effectiveCwd, file: null });
  }

  function select(next: PlaybookSelection): void {
    const scope = next.cwd ?? effectiveCwd;
    if (scope === null) return;
    if (!confirmDiscard()) return;
    applySelection({ cwd: scope, file: next.file });
  }

  function refreshListing(): void {
    void loadListing(selection.cwd ?? null);
  }

  // One listing per scope. `null` asks the server for its own directory, which is the fallback scope.
  $effect(() => {
    const scope = selection.cwd;
    void loadListing(scope);
  });

  // A client-side link away from this screen must ask too (FR24); a full unload is the editor's
  // `beforeunload`. Both read the flag the editor reports.
  beforeNavigate((navigation) => {
    if (!dirty) return;
    if (typeof window !== "undefined" && window.confirm(DISCARD)) return;
    navigation.cancel();
  });

  onMount(() => {
    cwdInput = selection.cwd ?? "";
    suggestions = readRecents();
    const onPop = (): void => {
      selection = readSelection();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  });

  const playbooks = $derived(listing?.playbooks ?? []);
  const failures = $derived(listing?.errors ?? []);
  const empty = $derived(
    listing !== null && playbooks.length === 0 && failures.length === 0,
  );
</script>

<svelte:head>
  <title>Playbooks · Argos</title>
</svelte:head>

<header class="mb-3.5 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="m-0 text-xl font-semibold">Playbooks</h1>
    <p class="mt-0.5 mb-0 text-[13px] text-surface-600-400">
      Edit a repository playbook and save it through <code class="font-mono text-[12px]"
        >argos serve</code
      >. The loader judges every save; nothing invalid reaches the disk.
    </p>
  </div>
  <form class="flex items-end gap-1.5" onsubmit={submitScope}>
    <label class="label text-[11px] text-surface-700-300">
      <span>Repository</span>
      <input
        bind:value={cwdInput}
        list="argos-playbook-cwds"
        class="input w-[min(52vw,360px)]"
        placeholder="/absolute/path/to/repo"
        spellcheck="false"
        autocomplete="off"
      />
    </label>
    <datalist id="argos-playbook-cwds">
      {#each suggestions as suggestion (suggestion)}
        <option value={suggestion}></option>
      {/each}
    </datalist>
    <button
      type="submit"
      class="btn preset-tonal shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={cwdInput.trim() === ""}>Load</button
    >
  </form>
</header>

{#if effectiveCwd === null && !listingLoading}
  <EmptyState
    title="No repository selected"
    hint="Enter the absolute path of a repository above, or run a workflow once so its directory is remembered. The editor lists .argos/playbooks and .paseo/plugins/playbooks."
  />
{:else}
  <div class="grid items-start gap-5 lg:grid-cols-[240px_1fr]">
    <aside class="hidden lg:block">
      <PlaybookRail
        cwd={effectiveCwd}
        {playbooks}
        errors={failures}
        selectedFile={selection.file}
        loading={listingLoading}
        onSelect={openFile}
      />
    </aside>

    <div class="min-w-0">
      {#if selection.file !== null && effectiveCwd !== null}
        <div class="mb-2.5 flex flex-wrap items-center gap-2 text-[12px] text-surface-600-400">
          <button type="button" class="text-primary-700-300 hover:underline" onclick={closeFile}
            >All playbooks</button
          >
          <span aria-hidden="true">·</span>
          <span class="truncate font-mono" title={selection.file}>{selection.file}</span>
        </div>
        <PlaybookEditor
          cwd={effectiveCwd}
          file={selection.file}
          {api}
          onDirtyChange={(value) => (dirty = value)}
          onSaved={refreshListing}
        />
      {:else if listingError !== null}
        <p
          class={[
            "card m-0 border border-error-500/40 bg-error-500/15 p-3 text-[13px]",
            toneClass(TONE_TEXT, "danger"),
          ]}
          data-tone="danger"
          role="alert"
        >
          <code class="font-mono text-[12px]">{listingError.code}</code> {listingError.message}
        </p>
      {:else if listingLoading && listing === null}
        <p class="p-8 text-center text-surface-600-400" aria-busy="true">Loading playbooks…</p>
      {:else if empty}
        <EmptyState
          title="No playbook in this repository"
          hint="Add a YAML file under .argos/playbooks/ (or .paseo/plugins/playbooks/) and load the directory again."
        />
      {:else}
        <EmptyState
          title="Pick a playbook"
          hint="Choose a file from the rail to read and edit its YAML. A file that fails to load is listed too, so you can fix it here."
        />
      {/if}
    </div>
  </div>
{/if}
