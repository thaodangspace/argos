<script lang="ts">
  let {
    title,
    hint,
  }: { title: string; hint: string } = $props();
</script>

<div
  class="rounded-lg border border-dashed border-surface-300-700 px-6 py-14 text-center text-surface-600-400"
>
  <div class="mb-2 text-[28px]" aria-hidden="true">◎</div>
  <h2 class="mb-1.5 text-[15px] text-surface-950-50">{title}</h2>
  <p class="mx-auto max-w-[52ch] text-[13px]">{hint}</p>
</div>
