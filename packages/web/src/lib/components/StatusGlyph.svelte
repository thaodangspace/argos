<script lang="ts">
  import type { StatusTone } from "@thaodangspace/argos-core/view";

  let {
    glyph,
    tone,
    label,
    pulse = false,
  }: { glyph: string; tone: StatusTone; label: string; pulse?: boolean } = $props();
</script>

<span
  class="glyph tone-{tone}"
  class:pulse
  role="img"
  aria-label={label}
  title={label}
>{glyph}</span>

<style>
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    font-size: 13px;
    line-height: 1;
    flex: none;
  }

  .pulse {
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
</style>
