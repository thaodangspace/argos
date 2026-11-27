<script lang="ts">
  /**
   * The playbook editor card (editor FR22–FR25): a textarea over the raw YAML, the loader's verdict
   * after a 400 ms debounce, the issues panel with a click-to-line affordance, and the conflict panel
   * a lost save turns into.
   *
   * The buffer lives here and nowhere else — one editor per tab, and a draft is never stored on the
   * server (spec "State"). The decisions an operator can argue with (dirty? can Save?) come from
   * `lib/playbook-editor.ts`; this component renders them.
   *
   * No hand-written CSS: the textarea and the panels are Skeleton utilities plus the literal tone
   * records, so `lib/style-guard.test.ts` stays green.
   */
  import { onMount } from "svelte";

  import type { PlaybookIssue, PlaybookVerdict } from "@thaodangspace/argos-core/rpc/contracts";

  import { createApi, toApiError, type PlaybookApi } from "#lib/api";
  import {
    conflictText,
    DEBOUNCE_MS,
    isDirty,
    isWritablePlaybook,
    issueList,
    lineForIssue,
    offsetForLine,
    saveEligibility,
  } from "#lib/playbook-editor";
  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let {
    cwd,
    file,
    api = createApi(),
    onDirtyChange,
    onSaved,
  }: {
    cwd: string;
    /** The path the editor opened. Writability is derived from it, never trusted by the server. */
    file: string;
    api?: PlaybookApi;
    /** Reports the dirty flag, so the page can guard a file change and a route change. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Called after a save landed, so the page can refresh the rail's hashes. */
    onSaved?: () => void;
  } = $props();

  /** Skeleton's `card` is a radius only; the border and padding are utilities (see StartRunDialog). */
  const PANEL = "card border border-surface-200-800 bg-surface-100-900";
  const CODE = "font-mono text-[12px]";

  let buffer = $state("");
  let loaded = $state("");
  let verdict = $state<PlaybookVerdict | null>(null);
  /** The text the current verdict describes: a verdict older than the buffer never enables Save. */
  let validatedText = $state("");
  let sha256 = $state("");
  let ready = $state(false);
  let loading = $state(false);
  let validating = $state(false);
  let saving = $state(false);
  let loadError = $state<{ code: string; message: string } | null>(null);
  let saveError = $state<{ code: string; message: string } | null>(null);
  /** The `details.reason` of a `409`, kept as-is so an unknown reason still opens the panel. */
  let conflict = $state<string | null>(null);
  let highlighted = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();
  let loadToken = 0;
  let validateToken = 0;

  const writable = $derived(isWritablePlaybook(cwd, file));
  const dirty = $derived(isDirty(buffer, loaded));
  const currentVerdict = $derived(verdict !== null && validatedText === buffer ? verdict : null);
  const eligibility = $derived(
    saveEligibility({ dirty, valid: currentVerdict?.valid === true, writable }),
  );
  const issues = $derived(verdict === null ? { issues: [], hidden: 0 } : issueList(verdict.errors));
  const warnings = $derived(verdict?.warnings ?? []);
  const baseName = $derived(file.split(/[/\\]/).pop() ?? file);

  function failure(error: unknown): { code: string; message: string } {
    const api = toApiError(error);
    return { code: api.code, message: api.message };
  }

  function reset(): void {
    buffer = "";
    loaded = "";
    verdict = null;
    validatedText = "";
    sha256 = "";
    ready = false;
    loadError = null;
    saveError = null;
    conflict = null;
    highlighted = "";
  }

  /** One read of the file on disk: the yaml, its digest, and the verdict for those exact bytes. */
  async function load(): Promise<void> {
    const token = ++loadToken;
    reset();
    loading = true;
    try {
      const response = await api.getPlaybookFile({ cwd, file });
      if (token !== loadToken) return;
      buffer = response.yaml;
      loaded = response.yaml;
      verdict = response;
      validatedText = response.yaml;
      sha256 = response.sha256;
      ready = true;
    } catch (error) {
      if (token !== loadToken) return;
      loadError = failure(error);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  /** One validation of one buffer; the newest answer wins, an older one is dropped. */
  async function validate(text: string): Promise<void> {
    const token = ++validateToken;
    validating = true;
    try {
      const result = await api.validatePlaybook({ cwd, file, yaml: text });
      if (token !== validateToken) return;
      verdict = result;
      validatedText = text;
      saveError = null;
    } catch (error) {
      if (token !== validateToken) return;
      saveError = failure(error);
    } finally {
      if (token === validateToken) validating = false;
    }
  }

  async function save(): Promise<void> {
    if (saving || !eligibility.canSave) return;
    const text = buffer;
    saving = true;
    saveError = null;
    conflict = null;
    try {
      const response = await api.savePlaybook({ cwd, file, yaml: text, baseSha256: sha256 });
      sha256 = response.sha256;
      loaded = text;
      verdict = response;
      validatedText = text;
      onSaved?.();
    } catch (error) {
      const api = toApiError(error);
      if (api.code === "playbook_conflict") {
        const reason = api.details?.["reason"];
        conflict = typeof reason === "string" ? reason : "";
        return;
      }
      saveError = { code: api.code, message: api.message };
    } finally {
      saving = false;
    }
  }

  /** Reload the bytes on disk, dropping the buffer (the conflict panel's first action). */
  function reload(): void {
    void load();
  }

  /**
   * The conflict panel's second action (FR25): re-read the digest only, keep the buffer, and send a
   * second `PUT` with the fresh `baseSha256`. The buffer is what the operator chose to keep.
   *
   * A blocked save must say why instead of dropping the panel: `save()` returns early when the
   * buffer is no longer saveable (invalid, clean, read-only), so clearing `conflict` first would
   * hide the panel and write nothing. Only a save that really starts clears it.
   */
  async function overwrite(): Promise<void> {
    if (saving || !eligibility.canSave) {
      saveError = { code: eligibility.reason ?? "save_blocked", message: eligibility.hint };
      return;
    }
    try {
      const fresh = await api.getPlaybookFile({ cwd, file });
      sha256 = fresh.sha256;
      await save();
    } catch (error) {
      conflict = null;
      saveError = failure(error);
    }
  }

  function onInput(event: Event): void {
    buffer = (event.currentTarget as HTMLTextAreaElement).value;
  }

  /** Click-to-line (FR22): move the caret when the path maps to a line, else only highlight. */
  function jumpTo(issue: PlaybookIssue): void {
    highlighted = `${issue.path}\u0000${issue.stepId ?? ""}`;
    const line = lineForIssue(issue.path, buffer);
    if (line === undefined || textarea === undefined) return;
    const offset = offsetForLine(buffer, line);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
  }

  function issueKey(issue: PlaybookIssue): string {
    return `${issue.path}\u0000${issue.stepId ?? ""}`;
  }

  // One load per selection: the page changes `cwd`/`file` only after it has guarded a dirty buffer.
  $effect(() => {
    if (cwd === "" || file === "") return;
    void load();
  });

  // The 400 ms debounce (FR22): the cleanup cancels the pending call, so a burst of typing is one
  // request and only the last buffer is validated.
  $effect(() => {
    const text = buffer;
    if (!ready) return;
    if (text === loaded) return;
    const timer = setTimeout(() => {
      void validate(text);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  $effect(() => {
    onDirtyChange?.(dirty);
  });

  onMount(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirty(buffer, loaded)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<section class={PANEL} aria-label="Playbook editor">
  <header class="flex flex-wrap items-center gap-2 border-b border-surface-200-800 px-4 py-2.5">
    <h2 class="m-0 min-w-0 flex-1 truncate font-mono text-[13px] text-surface-950-50" title={file}>
      {baseName}
    </h2>
    {#if verdict !== null}
      <span
        class={[
          "badge preset-tonal text-[11px]",
          verdict.valid ? toneClass(TONE_TEXT, "success") : toneClass(TONE_TEXT, "danger"),
        ]}
        data-tone={verdict.valid ? "success" : "danger"}
      >
        {verdict.valid ? "valid" : "invalid"}
      </span>
    {/if}
    {#if dirty}
      <span class="badge preset-tonal text-[11px]" data-tone="warning">unsaved</span>
    {/if}
    {#if validating}
      <span class="text-[11px] text-surface-600-400" aria-live="polite">validating…</span>
    {/if}
  </header>

  {#if loading}
    <p class="m-0 px-4 py-6 text-[13px] text-surface-600-400" aria-busy="true">Loading playbook…</p>
  {:else if loadError !== null}
    <!-- A refused read is never an empty editor: the operator sees the code and the message. -->
    <p
      class={[
        "m-0 m-4 border border-error-500/40 bg-error-500/15 p-2.5 text-[13px]",
        toneClass(TONE_TEXT, "danger"),
      ]}
      data-tone="danger"
      role="alert"
    >
      <code class={CODE}>{loadError.code}</code> {loadError.message}
    </p>
  {:else}
    <div class="px-4 pt-3">
      <textarea
        bind:this={textarea}
        class="textarea h-[52vh] min-h-[280px] w-full resize-y font-mono text-[12px] leading-relaxed"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        aria-label={`YAML for ${baseName}`}
        value={buffer}
        oninput={onInput}
        disabled={saving}
      ></textarea>
    </div>

    <div class="flex flex-wrap items-center gap-2 px-4 pt-2 pb-3">
      {#if writable}
        <button
          type="button"
          class="btn preset-filled-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
          title={eligibility.hint}
          disabled={!eligibility.canSave || saving}
          onclick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      {:else}
        <span class="badge preset-tonal text-[11px]" data-tone="neutral">read-only</span>
      {/if}
      <button
        type="button"
        class="btn preset-tonal disabled:cursor-not-allowed disabled:opacity-50"
        disabled={saving}
        onclick={reload}>Reload from disk</button
      >
      <span class="flex-1"></span>
      <span class="text-[11px] text-surface-600-400">{eligibility.hint}</span>
    </div>

    {#if saveError !== null}
      <p
        class={[
          "m-0 mx-4 mb-3 border border-error-500/40 bg-error-500/15 p-2.5 text-[13px]",
          toneClass(TONE_TEXT, "danger"),
        ]}
        data-tone="danger"
        role="alert"
      >
        <code class={CODE}>{saveError.code}</code> {saveError.message}
      </p>
    {/if}

    {#if conflict !== null}
      <div
        class="mx-4 mb-3 border border-warning-500/40 bg-warning-500/15 p-3 text-[13px]"
        role="alert"
        aria-label="Save conflict"
      >
        <p class="m-0">
          <strong class="font-mono text-[12px]">409 playbook_conflict</strong>
          {#if conflict !== ""}<span class="text-[12px] text-surface-600-400">· {conflict}</span>{/if}
        </p>
        <p class="mt-1 mb-2">{conflictText(conflict === "" ? undefined : conflict)}</p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn preset-filled-primary-500" onclick={reload}
            >Reload from disk</button
          >
          <button type="button" class="btn preset-tonal" onclick={overwrite}>Overwrite</button>
        </div>
      </div>
    {/if}

    {#if issues.issues.length > 0 || issues.hidden > 0}
      <section class="border-t border-surface-200-800 px-4 py-3" aria-label="Issues">
        <h3 class="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400">
          Issues
          {#if issues.hidden > 0}<span class="ml-1 normal-case">(+{issues.hidden} more)</span>{/if}
        </h3>
        <ul class="mt-1.5 flex flex-col gap-1 p-0" role="list">
          {#each issues.issues as issue, index (`${issueKey(issue)}\u0000${issue.message}`)}
            <li>
              <button
                type="button"
                class={[
                  "w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-surface-200-800/60",
                  highlighted === issueKey(issue)
                    ? "bg-surface-200-800/60 text-surface-950-50"
                    : "text-surface-700-300",
                ]}
                onclick={() => jumpTo(issue)}
              >
                <span class={["font-mono text-[11px]", toneClass(TONE_TEXT, "danger")]} data-tone="danger"
                  >{index + 1}. {issue.path}</span
                >
                {#if issue.stepId !== undefined}
                  <span class="ml-1 text-[11px] text-surface-600-400">step {issue.stepId}</span>
                {/if}
                <span class="block">{issue.message}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if warnings.length > 0}
      <section class="border-t border-surface-200-800 px-4 py-3" aria-label="Warnings">
        <h3 class="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400">
          Warnings
        </h3>
        <ul class="mt-1.5 flex flex-col gap-1 p-0 text-[12px] text-surface-700-300" role="list">
          {#each warnings as warning, index (`${warning.file}:${String(index)}:${warning.code}`)}
            <li>
              <code class={CODE}>{warning.code}</code>
              {#if warning.stepId !== null}<span class="ml-1 text-surface-600-400"
                  >step {warning.stepId}</span
                >{/if}
              <span class="block">{warning.message}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</section>
