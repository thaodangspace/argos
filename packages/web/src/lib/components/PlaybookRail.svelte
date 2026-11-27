<script lang="ts">
  /**
   * The playbook rail (editor FR20): one row per discovered file under the scope `cwd`, including a
   * file that fails to load — an operator has to be able to open and fix a broken playbook (FR2), so
   * a loader failure is a row with its own marker, never a hidden entry.
   *
   * Presentation only: the page owns the listing, the selection, and the URL.
   */
  import type { PlaybookLoadError, PlaybookSummary } from "@thaodangspace/argos-core/rpc/contracts";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let {
    cwd,
    playbooks,
    errors,
    selectedFile,
    loading = false,
    onSelect,
  }: {
    cwd: string | null;
    playbooks: readonly PlaybookSummary[];
    /** Files discovery found but the loader refused; each is still openable. */
    errors: readonly PlaybookLoadError[];
    selectedFile: string | null;
    loading?: boolean;
    onSelect: (file: string) => void;
  } = $props();

  const HEADING =
    "mt-0 mb-0.5 px-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-surface-600-400";
  const ROW =
    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[13px] text-surface-700-300 hover:bg-surface-200-800/60 aria-[current=true]:bg-primary-500/15 aria-[current=true]:font-semibold aria-[current=true]:text-surface-950-50";
  const COUNT = "shrink-0 text-[11px] tabular-nums text-surface-600-400";

  function baseName(file: string): string {
    return file.split(/[/\\]/).pop() ?? file;
  }
</script>

<nav
  class="sticky top-3 flex flex-col gap-1 rounded-lg border border-surface-200-800 bg-surface-100-900 p-2"
  aria-label="Playbooks"
>
  <h2 class={HEADING}>Playbooks</h2>
  {#if cwd !== null}
    <p class="mt-0 mb-1 truncate px-1.5 font-mono text-[11px] text-surface-600-400" title={cwd}>
      {cwd}
    </p>
  {/if}

  {#if loading && playbooks.length === 0 && errors.length === 0}
    <p class="m-0 px-1.5 py-1 text-[12px] text-surface-600-400" aria-busy="true">Loading…</p>
  {:else if playbooks.length === 0 && errors.length === 0}
    <p class="m-0 px-1.5 py-1 text-[12px] text-surface-600-400">No playbook found here.</p>
  {:else}
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      {#each playbooks as playbook (playbook.file)}
        <li>
          <button
            type="button"
            class={ROW}
            title={playbook.file}
            aria-current={selectedFile === playbook.file ? "true" : undefined}
            onclick={() => onSelect(playbook.file)}
          >
            <span class="truncate">{playbook.id}</span>
            <span class={COUNT}>{playbook.stepCount} steps</span>
          </button>
        </li>
      {/each}
      {#each errors as entry (entry.file)}
        <li>
          <button
            type="button"
            class={ROW}
            title={entry.file}
            aria-current={selectedFile === entry.file ? "true" : undefined}
            onclick={() => onSelect(entry.file)}
          >
            <span class="flex min-w-0 items-center gap-1">
              <span
                class={["text-[9px]", toneClass(TONE_TEXT, "danger")]}
                data-tone="danger"
                aria-hidden="true">●</span
              >
              <span class="truncate">{baseName(entry.file)}</span>
            </span>
            <span class={["text-[11px]", toneClass(TONE_TEXT, "danger")]} data-tone="danger"
              >{entry.code}</span
            >
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
