<script lang="ts">
  let { text, label = "Copy" }: { text: string; label?: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1_500);
    } catch {
      copied = false;
    }
  }
</script>

<button type="button" class="copy" onclick={copy} aria-label={label} title={label}>
  {copied ? "Copied" : "Copy"}
</button>

<style>
  .copy {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }

  .copy:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
</style>
