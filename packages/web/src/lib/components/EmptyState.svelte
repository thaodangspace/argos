<script lang="ts">
  let {
    title,
    hint,
  }: { title: string; hint: string } = $props();
</script>

<div class="empty">
  <div class="mark" aria-hidden="true">◎</div>
  <h2>{title}</h2>
  <p>{hint}</p>
</div>

<style>
  .empty {
    text-align: center;
    padding: 56px 24px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--muted);
  }

  .mark {
    font-size: 28px;
    color: var(--muted);
    margin-bottom: 8px;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 15px;
    color: var(--text);
  }

  p {
    margin: 0 auto;
    max-width: 52ch;
    font-size: 13px;
  }
</style>
