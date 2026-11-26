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

<button
  type="button"
  class="btn btn-xs preset-tonal-surface"
  onclick={copy}
  aria-label={label}
  title={label}
>
  {copied ? "Copied" : "Copy"}
</button>
