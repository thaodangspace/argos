/**
 * Small presentational primitives for the Argos panel (theme tokens only, no panel logic).
 *
 * The panel is deliberately plain: Paseo owns typography and chrome, so these render status
 * glyphs, pills, buttons, and monospace log text with the tokens it hands us.
 */

import { useEffect, useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";

import { type PanelModel, type PanelStore, type StatusTone } from "../shared/panel";

export const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function toneColor(theme: PluginTheme, tone: StatusTone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "accent":
      return theme.colors.accent;
    case "neutral":
      return theme.colors.foregroundMuted;
  }
}

/** Subscribe one component to the store (no external state library). */
export function usePanel(panel: PanelStore): PanelModel {
  const [model, setModel] = useState<PanelModel>(() => panel.getModel());
  useEffect(() => panel.subscribe(setModel), [panel]);
  return model;
}

export function Pill({
  theme,
  label,
  tone,
}: {
  theme: PluginTheme;
  label: string;
  tone: StatusTone;
}) {
  return (
    <span
      style={{
        color: toneColor(theme, tone),
        border: `1px solid ${theme.colors.border}`,
        borderRadius: 999,
        padding: "0 8px",
        fontSize: 11,
        lineHeight: "18px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/** `✓` / `✕` / `●` — a status column that reads without color. */
export function StatusGlyph({
  theme,
  glyph,
  tone,
  size = 13,
}: {
  theme: PluginTheme;
  glyph: string;
  tone: StatusTone;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        color: toneColor(theme, tone),
        fontSize: size,
        lineHeight: `${size + 3}px`,
        width: size + 4,
        display: "inline-block",
        textAlign: "center",
        flexShrink: 0,
      }}
    >
      {glyph}
    </span>
  );
}

export function buttonStyle(
  theme: PluginTheme,
  tone: StatusTone,
  disabled = false,
  filled = false,
) {
  return {
    background: filled ? toneColor(theme, tone) : theme.colors.surface0,
    color: filled ? theme.colors.accentForeground : toneColor(theme, tone),
    border: `1px solid ${filled ? toneColor(theme, tone) : theme.colors.border}`,
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 11,
    lineHeight: "16px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  } as const;
}

export function fieldStyle(theme: PluginTheme) {
  return {
    width: "100%",
    background: theme.colors.surface0,
    color: theme.colors.foreground,
    border: `1px solid ${theme.colors.border}`,
    borderRadius: 6,
    padding: "4px 6px",
    fontSize: 12,
    boxSizing: "border-box",
  } as const;
}

/** A muted monospace id (`#01M798D7`). */
export function RunId({ theme, id }: { theme: PluginTheme; id: string }) {
  return (
    <span
      title={id}
      style={{ fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.foregroundMuted }}
    >
      #{id}
    </span>
  );
}
/** A thin segmented progress bar: one square per step, colored by its status. */
export function StepProgress({
  theme,
  segments,
}: {
  theme: PluginTheme;
  segments: readonly { id: string; label: string; tone: StatusTone }[];
}) {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {segments.map((segment) => (
        <span
          key={segment.id}
          title={segment.label}
          style={{
            width: 7,
            height: 7,
            borderRadius: 2,
            background: toneColor(theme, segment.tone),
            opacity: segment.tone === "neutral" ? 0.45 : 1,
          }}
        />
      ))}
    </span>
  );
}
