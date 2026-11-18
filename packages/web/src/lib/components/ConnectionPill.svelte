<script lang="ts">
  import type { EventStatus } from "../events.js";

  let { status }: { status: EventStatus } = $props();

  const label = $derived(
    status === "open"
      ? "Live"
      : status === "connecting"
        ? "Connecting"
        : status === "reconnecting"
          ? "Reconnecting"
          : "Disconnected",
  );
</script>

<span
  class="pill"
  class:open={status === "open"}
  class:warn={status === "connecting" || status === "reconnecting"}
  class:down={status === "closed"}
  role="status"
  aria-live="polite"
>
  <span class="dot"></span>
  {label}
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }

  .open {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 40%, transparent);
  }
  .open .dot {
    background: var(--success);
  }

  .warn {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 40%, transparent);
  }
  .warn .dot {
    background: var(--warning);
    animation: blink 1.4s ease-in-out infinite;
  }

  .down {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .down .dot {
    background: var(--danger);
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
</style>
