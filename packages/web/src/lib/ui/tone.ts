/**
 * The only tone → class map (spec FR10). A tone must become a class through a literal record like
 * these, never through interpolation: Tailwind's scanner cannot see `bg-{tone}`, so the class would
 * be missing in the production build and in no test.
 *
 * Values are Skeleton's colour *pairings* (`-700-300`, `~500`), so one class serves both modes.
 */

import type { StatusTone } from "@thaodangspace/argos-core/view";

const TONES = [
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
] as const satisfies readonly StatusTone[];

/** Label/glyph colour: the accessible text pairing (dark on light, light on dark). */
export const TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  neutral: "text-surface-700-300",
  accent: "text-primary-700-300",
  success: "text-success-700-300",
  warning: "text-warning-700-300",
  danger: "text-error-700-300",
};

/**
 * Solid background: dots, bars, and other small filled marks. `-800-200`, not `-500`: Vintage's
 * light surface is mid-grey (`surface-100`), so its pastel 500s vanish on it (success/warning ≈1.1:1);
 * 800 keeps the hue at 2.3–4.3:1 there and 200 reads ≥9:1 on the dark surface. Neutral (pending,
 * skipped) is a translucent ink so it stays visible but quieter than any coloured mark.
 */
export const TONE_BG: Readonly<Record<StatusTone, string>> = {
  neutral: "bg-surface-700-300/50",
  accent: "bg-primary-800-200",
  success: "bg-success-800-200",
  warning: "bg-warning-800-200",
  danger: "bg-error-800-200",
};

/** Quiet background: badges, chips, and callouts. */
export const TONE_BG_SOFT: Readonly<Record<StatusTone, string>> = {
  neutral: "bg-surface-500/15",
  accent: "bg-primary-500/15",
  success: "bg-success-500/15",
  warning: "bg-warning-500/15",
  danger: "bg-error-500/15",
};

/** Border: a card or callout that has to read as its tone without shouting. */
export const TONE_BORDER: Readonly<Record<StatusTone, string>> = {
  neutral: "border-surface-500/40",
  accent: "border-primary-500/40",
  success: "border-success-500/40",
  warning: "border-warning-500/40",
  danger: "border-error-500/40",
};

/** SVG fill: the graph's nodes and markers (a `<marker>` path does not inherit `fill`). */
export const TONE_FILL: Readonly<Record<StatusTone, string>> = {
  neutral: "fill-surface-500",
  accent: "fill-primary-500",
  success: "fill-success-500",
  warning: "fill-warning-500",
  danger: "fill-error-500",
};

/** One tone → one class; an unknown tone falls back to `neutral` (the raw value stays on `data-tone`). */
export function toneClass(
  map: Readonly<Record<StatusTone, string>>,
  tone: StatusTone | string | undefined,
): string {
  return map[(tone ?? "neutral") as StatusTone] ?? map.neutral;
}

/** The tone ids, for a caller that needs to enumerate them. */
export const TONE_VALUES: readonly StatusTone[] = TONES;
