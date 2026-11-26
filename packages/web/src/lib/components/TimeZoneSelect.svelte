<script lang="ts">
  /**
   * The time zone every timestamp is rendered in.
   *
   * The list is the reader's own zone ("Local", the default), then `UTC`, then every IANA id this
   * runtime knows. It sits in the topbar because it belongs to the whole surface — the list, the run
   * page, and every step log — and because it is a *rendering* choice, not a scope: the URL's list
   * state stays untouched (see `state/timezone.svelte.ts`).
   */
  let {
    system,
    value,
    zones,
    onSelect,
  }: {
    /** The browser's own zone id: the "Local" entry, and what an unset choice means. */
    system: string;
    /** The chosen zone id, or `undefined` while following the browser. */
    value: string | undefined;
    /** The explicit choices, without `system` (the "Local" entry already names it). */
    zones: readonly string[];
    onSelect: (zone: string) => void;
  } = $props();
</script>

<label class="inline-flex items-center gap-1.5 text-[12px] text-surface-600-400">
  <span class="whitespace-nowrap max-sm:sr-only">Time zone</span>
  <select
    class="select w-auto max-w-60 text-[12px] max-sm:max-w-36"
    value={value ?? ""}
    title="Timestamps are shown in this zone"
    onchange={(event) => onSelect((event.currentTarget as HTMLSelectElement).value)}
  >
    <option value="">Local · {system}</option>
    {#each zones as zone (zone)}
      <option value={zone}>{zone}</option>
    {/each}
  </select>
</label>
