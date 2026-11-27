<script lang="ts">
  import { tick } from "svelte";

  import { Dialog } from "@skeletonlabs/skeleton-svelte";
  import type { Scalar, StartRunRequest } from "@thaodangspace/argos-core/rpc/contracts";
  import type { PlaybookInput, PlaybookSummary } from "@thaodangspace/argos-core/rpc/contracts";

  import { createApi, toApiError, type ArgosApi } from "#lib/api";
  import {
    buildStartRequest,
    initialValues,
    newClientRequestId,
    type FieldErrors,
  } from "#lib/start-form";
  import { addRecent, readRecents, writeRecents } from "#lib/state/recents";
  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let {
    open,
    onClose,
    onStarted,
    api = createApi(),
    initial,
  }: {
    open: boolean;
    onClose: () => void;
    onStarted: (runId: string) => void;
    api?: ArgosApi;
    initial?: {
      readonly cwd?: string;
      readonly playbookId?: string;
      readonly inputs?: Readonly<Record<string, Scalar>>;
    };
  } = $props();

  let cwd = $state("");
  let recents = $state<string[]>([]);
  let loading = $state(false);
  let playbooks = $state<PlaybookSummary[]>([]);
  let loadError = $state<{ code: string; message: string } | null>(null);
  let loadWarnings = $state<{ file: string; code: string; message: string }[]>([]);
  let selectedId = $state("");
  let values = $state<Record<string, string | number | boolean>>({});
  let isolation = $state<"none" | "worktree">("none");
  let executor = $state("");
  let executors = $state<string[]>([]);
  let errors = $state<FieldErrors>({});
  let serverError = $state<{ code: string; message: string } | null>(null);
  let submitting = $state(false);
  let clientRequestId = $state(newClientRequestId());
  let palette: HTMLInputElement | undefined = $state();

  const selected = $derived(playbooks.find((playbook) => playbook.id === selectedId) ?? null);

  /** The dialog's own surface: `card` is only a radius, so the border and padding are utilities. */
  const PANEL = "card w-full max-w-[620px] border border-surface-200-800 bg-surface-100-900 p-0";

  function reset(): void {
    const stored = readRecents();
    recents = stored;
    cwd = initial?.cwd ?? stored[0] ?? "";
    playbooks = [];
    loadError = null;
    loadWarnings = [];
    selectedId = initial?.playbookId ?? "";
    values = {};
    isolation = "none";
    executor = "";
    executors = [];
    errors = {};
    serverError = null;
    submitting = false;
    clientRequestId = newClientRequestId();
  }

  async function loadPlaybooks(): Promise<void> {
    const target = cwd.trim();
    if (target === "") {
      loadError = { code: "invalid_request", message: "Enter a working directory first." };
      return;
    }
    loading = true;
    loadError = null;
    try {
      const listing = await api.listPlaybooks(target);
      playbooks = listing.playbooks;
      loadWarnings = listing.errors;
      if (selectedId !== "" && !playbooks.some((playbook) => playbook.id === selectedId)) {
        selectedId = playbooks[0]?.id ?? "";
      }
      if (selectedId === "") selectedId = playbooks[0]?.id ?? "";
      applyPlaybookDefaults();
    } catch (error) {
      const failure = toApiError(error);
      loadError = { code: failure.code, message: failure.message };
    } finally {
      loading = false;
    }
  }

  function applyPlaybookDefaults(): void {
    const playbook = playbooks.find((entry) => entry.id === selectedId);
    if (playbook === undefined) return;
    values = initialValues(playbook.inputs);
    for (const [name, value] of Object.entries(initial?.inputs ?? {})) {
      values[name] = typeof value === "boolean" ? value : String(value);
    }
    isolation = playbook.isolation ?? "none";
    executor = playbook.executor ?? "";
    recents = addRecent(recents, cwd);
    writeRecents(recents);
  }

  function onSelectPlaybook(event: Event): void {
    selectedId = (event.currentTarget as HTMLSelectElement).value;
    applyPlaybookDefaults();
  }

  function fieldError(name: string): string | undefined {
    return errors[name];
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (selected === null || submitting) return;
    const built = buildStartRequest({
      playbook: selected,
      cwd,
      values,
      isolation,
      ...(executor === "" ? {} : { executor }),
    });
    errors = built.ok ? {} : built.errors;
    if (!built.ok) return;

    const request: StartRunRequest = { ...built.request, clientRequestId };
    submitting = true;
    serverError = null;
    try {
      const started = await api.startRun(request);
      recents = addRecent(recents, cwd);
      writeRecents(recents);
      onStarted(started.runId);
    } catch (error) {
      const failure = toApiError(error);
      serverError = { code: failure.code, message: failure.message };
    } finally {
      submitting = false;
    }
  }

  // One reset per open (not per render): `reset()` writes the form state it would otherwise read,
  // and the parent may pass a fresh `initial` object on every frame.
  let opened = false;
  $effect(() => {
    if (!open) {
      opened = false;
      return;
    }
    if (opened) return;
    opened = true;
    reset();
    // A prefilled cwd (the "Start similar" entry point, or a recent directory) should list its
    // playbooks immediately; the operator can still retype it and press Load.
    if (cwd.trim() !== "") void loadPlaybooks();
    void tick().then(() => {
      palette?.focus();
    });
    void api
      .info()
      .then((info) => {
        executors = (info.executors ?? []).map((entry) => entry.id);
      })
      .catch(() => {
        executors = [];
      });
  });

  function fieldKind(input: PlaybookInput): "text" | "number" | "boolean" | "enum" {
    if (input.type === "boolean") return "boolean";
    if (input.type === "number") return "number";
    if (input.type === "enum" || (input.values !== undefined && input.values.length > 0)) return "enum";
    return "text";
  }
</script>

<!-- Skeleton's `Dialog` (spec FR12) supplies what the hand-rolled overlay could not: a focus trap,
     `Escape`, scroll lock, and focus restored to the trigger. The form inside is unchanged — a
     native `<select>` of playbooks, a native checkbox per boolean input, and `start-form.ts`'
     coercion and validation (spec FR14). -->
<Dialog
  {open}
  onOpenChange={(details) => {
    if (!details.open) onClose();
  }}
  initialFocusEl={() => palette ?? false}
>
  <Dialog.Backdrop class="fixed inset-0 z-30 bg-surface-950/60" />
  <Dialog.Positioner
    class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto px-4 pt-[8vh] pb-4"
  >
    <Dialog.Content class={PANEL}>
      <header
        class="flex items-center justify-between border-b border-surface-200-800 px-4 py-3"
      >
        <Dialog.Title class="text-[15px] font-semibold text-surface-950-50">Run workflow</Dialog.Title>
        <Dialog.CloseTrigger class="btn-icon btn-icon-sm" aria-label="Close"
          ><span aria-hidden="true">×</span></Dialog.CloseTrigger
        >
      </header>
      <Dialog.Description class="sr-only">
        List a repository's playbooks and start one.
      </Dialog.Description>

      <form class="flex flex-col gap-3 px-4 pt-3.5 pb-4" onsubmit={submit}>
        <label class="label text-[12px] text-surface-700-300">
          <span>Working directory</span>
          <div class="flex gap-1.5">
            <input
              bind:this={palette}
              bind:value={cwd}
              list="argos-cwd-recents"
              class="input"
              placeholder="/absolute/path/to/repo"
              spellcheck="false"
              autocomplete="off"
            />
            <button
              type="button"
              class="btn preset-tonal shrink-0"
              disabled={loading}
              onclick={loadPlaybooks}
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          <datalist id="argos-cwd-recents">
            {#each recents as recent (recent)}
              <option value={recent}></option>
            {/each}
          </datalist>
          {#if errors["cwd"]}<span
              class={["text-[12px]", toneClass(TONE_TEXT, "danger")]}
              data-tone="danger">{errors["cwd"]}</span
            >{/if}
        </label>

        {#if loadError !== null}
          <p
            class={[
              "card m-0 border border-error-500/40 bg-error-500/15 p-2.5 text-[13px]",
              toneClass(TONE_TEXT, "danger"),
            ]}
            data-tone="danger"
            role="alert"
          >
            <code class="font-mono">{loadError.code}</code> {loadError.message}
          </p>
        {/if}

        {#if playbooks.length > 0}
          <label class="label text-[12px] text-surface-700-300">
            <span>Playbook</span>
            <select class="select" value={selectedId} onchange={onSelectPlaybook}>
              {#each playbooks as playbook (playbook.id)}
                <option value={playbook.id}>
                  {playbook.id} · {playbook.stepCount} steps{playbook.inputs.length > 0
                    ? ` · ${playbook.inputs.length} inputs`
                    : ""}
                </option>
              {/each}
            </select>
          </label>

          {#if loadWarnings.length > 0}
            <details class="text-[12px] text-surface-600-400">
              <summary>{loadWarnings.length} playbook(s) could not be loaded</summary>
              <ul>
                {#each loadWarnings as warning (warning.file)}
                  <li><code class="font-mono">{warning.code}</code> {warning.file}</li>
                {/each}
              </ul>
            </details>
          {/if}

          {#if selected !== null}
            {#each selected.inputs as input (input.name)}
              <label class="label text-[12px] text-surface-700-300">
                <span>
                  {input.name}
                  {#if input.required}<span
                      class={["ml-0.5", toneClass(TONE_TEXT, "danger")]}
                      data-tone="danger"
                      aria-hidden="true">*</span
                    >{/if}
                  <span class="badge preset-tonal ml-1.5 text-[10px] uppercase">{input.type}</span>
                </span>
                {#if fieldKind(input) === "boolean"}
                  <input
                    type="checkbox"
                    class="checkbox"
                    checked={values[input.name] === true}
                    onchange={(event) => {
                      values[input.name] = event.currentTarget.checked;
                    }}
                  />
                {:else if fieldKind(input) === "enum"}
                  <select
                    class="select"
                    value={String(values[input.name] ?? "")}
                    onchange={(event) => {
                      values[input.name] = event.currentTarget.value;
                    }}
                  >
                    <option value="">—</option>
                    {#each input.values ?? [] as value (value)}
                      <option value={value}>{value}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    type="text"
                    inputmode={fieldKind(input) === "number" ? "decimal" : undefined}
                    value={String(values[input.name] ?? "")}
                    class="input aria-invalid:border aria-invalid:border-error-500"
                    aria-invalid={fieldError(input.name) !== undefined}
                    oninput={(event) => {
                      values[input.name] = event.currentTarget.value;
                    }}
                  />
                {/if}
                {#if input.description}<span class="text-[11px] text-surface-600-400"
                    >{input.description}</span
                  >{/if}
                {#if fieldError(input.name)}
                  <span class={["text-[12px]", toneClass(TONE_TEXT, "danger")]} data-tone="danger"
                    >{fieldError(input.name)}</span
                  >
                {/if}
              </label>
            {/each}

            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label class="label text-[12px] text-surface-700-300">
                <span>Isolation</span>
                <select class="select" bind:value={isolation}>
                  <option value="none">none</option>
                  <option value="worktree">worktree</option>
                </select>
              </label>
              <label class="label text-[12px] text-surface-700-300">
                <span>Executor</span>
                <select class="select" bind:value={executor}>
                  <option value="">server default</option>
                  {#each executors as id (id)}
                    <option value={id}>{id}</option>
                  {/each}
                </select>
              </label>
            </div>
          {/if}
        {:else if !loading}
          <p class="m-0 text-[11px] text-surface-600-400">
            Enter a repository directory and press Load to list its playbooks.
          </p>
        {/if}

        {#if serverError !== null}
          <p
            class={[
              "card m-0 border border-error-500/40 bg-error-500/15 p-2.5 text-[13px]",
              toneClass(TONE_TEXT, "danger"),
            ]}
            data-tone="danger"
            role="alert"
          >
            <code class="font-mono">{serverError.code}</code> {serverError.message}
          </p>
        {/if}

        <footer class="flex justify-end gap-2 pt-1">
          <button
            type="button"
            class="btn preset-tonal disabled:cursor-not-allowed disabled:opacity-50"
            onclick={onClose}
            disabled={submitting}>Cancel</button
          >
          <button
            type="submit"
            class="btn preset-filled-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting || selected === null}
          >
            {submitting ? "Starting…" : "Run workflow"}
          </button>
        </footer>
      </form>
    </Dialog.Content>
  </Dialog.Positioner>
</Dialog>
