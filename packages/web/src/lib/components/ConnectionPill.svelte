<script lang="ts">
  import type { StatusTone } from "@thaodangspace/argos-core/view";

  import { TONE_BG, toneClass } from "#lib/ui/tone";
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

  const tone: StatusTone = $derived(
    status === "open" ? "success" : status === "closed" ? "danger" : "warning",
  );

  // Skeleton's tonal presets are bare (`preset-tonal-warning`, never `preset-tonal-warning-500`);
  // one literal per tone, so the scanner sees every class (spec FR4).
  const PRESET: Readonly<Record<StatusTone, string>> = {
    neutral: "preset-tonal",
    accent: "preset-tonal-primary",
    success: "preset-tonal-success",
    warning: "preset-tonal-warning",
    danger: "preset-tonal-error",
  };

  /** The dot only breathes while a connection is being (re)established. */
  const blinks = $derived(status === "connecting" || status === "reconnecting");
</script>

<span class={["badge", toneClass(PRESET, tone)]} data-tone={tone} role="status" aria-live="polite">
  <span
    class={["size-1.5 flex-none rounded-full", toneClass(TONE_BG, tone), blinks && "animate-pulse"]}
    aria-hidden="true"
  ></span>
  {label}
</span>
