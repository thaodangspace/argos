<script lang="ts">
  import { tick } from "svelte";

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

  async function onKeydown(event: KeyboardEvent): Promise<void> {
    if (event.key === "Escape" && !submitting) onClose();
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

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="overlay" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-run-title"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <header>
        <h2 id="start-run-title">Run workflow</h2>
        <button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
      </header>

      <form onsubmit={submit}>
        <label class="field">
          <span>Working directory</span>
          <div class="row">
            <input
              bind:this={palette}
              bind:value={cwd}
              list="argos-cwd-recents"
              placeholder="/absolute/path/to/repo"
              spellcheck="false"
              autocomplete="off"
            />
            <button type="button" class="secondary" disabled={loading} onclick={loadPlaybooks}>
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          <datalist id="argos-cwd-recents">
            {#each recents as recent (recent)}
              <option value={recent}></option>
            {/each}
          </datalist>
          {#if errors["cwd"]}<span class="error">{errors["cwd"]}</span>{/if}
        </label>

        {#if loadError !== null}
          <p class="error" role="alert"><code>{loadError.code}</code> {loadError.message}</p>
        {/if}

        {#if playbooks.length > 0}
          <label class="field">
            <span>Playbook</span>
            <select value={selectedId} onchange={onSelectPlaybook}>
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
            <details class="warnings">
              <summary>{loadWarnings.length} playbook(s) could not be loaded</summary>
              <ul>
                {#each loadWarnings as warning (warning.file)}
                  <li><code>{warning.code}</code> {warning.file}</li>
                {/each}
              </ul>
            </details>
          {/if}

          {#if selected !== null}
            {#each selected.inputs as input (input.name)}
              <label class="field">
                <span>
                  {input.name}
                  {#if input.required}<span class="required" aria-hidden="true">*</span>{/if}
                  <span class="type">{input.type}</span>
                </span>
                {#if fieldKind(input) === "boolean"}
                  <input
                    type="checkbox"
                    checked={values[input.name] === true}
                    onchange={(event) => {
                      values[input.name] = event.currentTarget.checked;
                    }}
                  />
                {:else if fieldKind(input) === "enum"}
                  <select
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
                    class:invalid={fieldError(input.name) !== undefined}
                    oninput={(event) => {
                      values[input.name] = event.currentTarget.value;
                    }}
                  />
                {/if}
                {#if input.description}<span class="hint">{input.description}</span>{/if}
                {#if fieldError(input.name)}
                  <span class="error">{fieldError(input.name)}</span>
                {/if}
              </label>
            {/each}

            <div class="options">
              <label class="field compact">
                <span>Isolation</span>
                <select bind:value={isolation}>
                  <option value="none">none</option>
                  <option value="worktree">worktree</option>
                </select>
              </label>
              <label class="field compact">
                <span>Executor</span>
                <select bind:value={executor}>
                  <option value="">server default</option>
                  {#each executors as id (id)}
                    <option value={id}>{id}</option>
                  {/each}
                </select>
              </label>
            </div>
          {/if}
        {:else if !loading}
          <p class="hint">
            Enter a repository directory and press Load to list its playbooks.
          </p>
        {/if}

        {#if serverError !== null}
          <p class="error banner" role="alert">
            <code>{serverError.code}</code> {serverError.message}
          </p>
        {/if}

        <footer>
          <button type="button" class="secondary" onclick={onClose} disabled={submitting}>Cancel</button>
          <button type="submit" class="primary" disabled={submitting || selected === null}>
            {submitting ? "Starting…" : "Run workflow"}
          </button>
        </footer>
      </form>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(1, 4, 9, 0.6);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8vh 16px 16px;
    z-index: 30;
    overflow-y: auto;
  }

  .dialog {
    width: min(620px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(1, 4, 9, 0.5);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 15px;
  }

  .close {
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
    line-height: 1;
  }

  form {
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .row {
    display: flex;
    gap: 6px;
  }

  input,
  select {
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }

  input[type="checkbox"] {
    width: auto;
    align-self: flex-start;
  }

  .invalid {
    border-color: var(--danger);
  }

  .error {
    color: var(--danger);
    font-size: 12px;
  }

  .banner {
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border));
    border-radius: 6px;
    background: var(--danger-soft);
  }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .required {
    color: var(--danger);
    margin-left: 2px;
  }

  .type {
    margin-left: 6px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
  }

  .hint {
    color: var(--muted);
    font-size: 11px;
  }

  .options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .warnings {
    font-size: 12px;
    color: var(--muted);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }

  .primary,
  .secondary {
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--border);
  }

  .primary {
    background: var(--success);
    border-color: var(--success);
    color: #04130a;
    font-weight: 600;
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    color: var(--text);
  }

  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }

  @media (max-width: 560px) {
    .options {
      grid-template-columns: 1fr;
    }
  }
</style>
