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
</script>

<a class="badge" class:quiet={count === 0} href={href("/gates")}>
  Gates <span class="count" aria-live="polite">{count}</span>
</a>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
  }

  .badge:hover {
    background: var(--surface-hover);
  }

  .count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--warning);
  }

  .quiet .count {
    color: var(--muted);
  }
</style>
