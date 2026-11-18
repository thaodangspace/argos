<script lang="ts">
  import { ToastStore } from "#lib/state/toasts.svelte";

  let { store }: { store: ToastStore } = $props();
</script>

<div class="stack" aria-live="polite" aria-atomic="false">
  {#each store.items as toast (toast.id)}
    <div class="toast {toast.tone}" role={toast.tone === "error" ? "alert" : "status"}>
      {#if toast.code}<code>{toast.code}</code>{/if}
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss" onclick={() => store.dismiss(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 20;
    max-width: min(420px, calc(100vw - 32px));
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 4px 16px rgba(1, 4, 9, 0.35);
    font-size: 13px;
  }

  .success {
    border-color: color-mix(in srgb, var(--success) 50%, var(--border));
  }

  .error {
    border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
  }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: var(--danger);
    white-space: nowrap;
  }

  span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  button {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }

  button:hover {
    color: var(--text);
  }
</style>
