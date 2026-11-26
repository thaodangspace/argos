<script lang="ts">
  /**
   * The header's live pending-gate count (inbox FR6): `Gates 2`, linking to the inbox.
   *
   * The count is a prop, not a store read, so the header stays testable without a route; the layout
   * feeds it from the shared runs stream, which is why it is live on every page.
   *
   * It deliberately has no hidden-workflow input (inbox FR9): the rail's `✕` hides a list row in this
   * browser, never work that waits for a person, so a hidden workflow's gate still counts here.
   */
  import { href } from "#lib/paths";

  let { count }: { count: number } = $props();

  // Skeleton's tonal presets are bare (`preset-tonal-warning`); quiet when nothing waits.
  const PILL = $derived(count === 0 ? "badge preset-tonal-surface" : "badge preset-tonal-warning");
</script>

<a class={PILL} href={href("/gates")}>
  Gates <span class="font-semibold tabular-nums" aria-live="polite">{count}</span>
</a>
