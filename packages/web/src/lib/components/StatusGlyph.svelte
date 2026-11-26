<script lang="ts">
  import type { StatusTone } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let {
    glyph,
    tone,
    label,
    pulse = false,
  }: { glyph: string; tone: StatusTone; label: string; pulse?: boolean } = $props();

  // Literal class strings only (spec FR4): Tailwind's scanner reads this file's text. The three parts
  // are complete class names — a `tone-{tone}` fragment would be dropped in the production build.
  const GLYPH = "inline-flex w-4 flex-none items-center justify-center text-[13px] leading-none";
</script>

<span
  class={[GLYPH, toneClass(TONE_TEXT, tone), pulse && "animate-pulse"]}
  data-tone={tone}
  role="img"
  aria-label={label}
  title={label}>{glyph}</span
>
