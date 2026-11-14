/**
 * Small presentational primitives for the Argos panel (theme tokens only, no panel logic).
 *
 * The panel is deliberately plain: Paseo owns typography and chrome, so these render status
 * glyphs, pills, buttons, and monospace log text with the tokens it hands us.
 *
 * Everything here is React Native (`View`/`Text`/`Pressable`), never DOM: Paseo renders plugins
 * natively on iOS/Android and through react-native-web on desktop. Three native rules shape the
 * code: every string sits inside a `Text`; a `Text` does not inherit color from a `View`, so every
 * `Txt` sets one; and a `View` lays out as a column unless it says `row`.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

import { type PanelModel, type PanelStore, type StatusTone } from "../shared/panel";

/** Native takes one family name; the web build passes the CSS stack through. */
export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

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

/** A horizontal row: centered children with a gap. */
export function Row({
  gap = 6,
  wrap = false,
  style,
  children,
}: {
  gap?: number;
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Themed text. `color` defaults to the foreground; `lines={1}` truncates with an ellipsis.
 * A nested `Txt` inherits the outer size and font, but always sets its own color.
 */
export function Txt({
  theme,
  color,
  size,
  mono = false,
  bold = false,
  lines,
  selectable,
  style,
  children,
}: {
  theme: PluginTheme;
  color?: string;
  size?: number;
  mono?: boolean;
  bold?: boolean;
  lines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}) {
  return (
    <Text
      {...(lines === undefined ? {} : { numberOfLines: lines })}
      {...(selectable === undefined ? {} : { selectable })}
      style={[
        { color: color ?? theme.colors.foreground },
        size === undefined ? null : { fontSize: size },
        mono ? { fontFamily: MONO_FONT } : null,
        bold ? { fontWeight: "600" } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
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
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        paddingHorizontal: 8,
      }}
    >
      <Txt theme={theme} color={toneColor(theme, tone)} size={11} lines={1} style={{ lineHeight: 18 }}>
        {label}
      </Txt>
    </View>
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
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color: toneColor(theme, tone),
        fontSize: size,
        lineHeight: size + 3,
        width: size + 4,
        textAlign: "center",
        flexShrink: 0,
      }}
    >
      {glyph}
    </Text>
  );
}

/** A small bordered button; `filled` paints the tone as the background. */
export function Button({
  theme,
  tone,
  label,
  onPress,
  disabled = false,
  filled = false,
  accessibilityLabel,
  style,
}: {
  theme: PluginTheme;
  tone: StatusTone;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const color = toneColor(theme, tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: filled ? color : theme.colors.surface0,
          borderWidth: 1,
          borderColor: filled ? color : theme.colors.border,
          borderRadius: 6,
          paddingVertical: 3,
          paddingHorizontal: 9,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <Txt
        theme={theme}
        color={filled ? theme.colors.accentForeground : color}
        size={11}
        lines={1}
        style={{ lineHeight: 16 }}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

/** A borderless pressable row (list rows, fold toggles). */
export function PressableRow({
  onPress,
  accessibilityLabel,
  expanded,
  style,
  children,
}: {
  onPress: () => void;
  accessibilityLabel?: string;
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(expanded === undefined ? {} : { accessibilityState: { expanded } })}
      onPress={onPress}
      style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}
    >
      {children}
    </Pressable>
  );
}

export function fieldStyle(theme: PluginTheme): TextStyle {
  return {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
    fontSize: 12,
  };
}

/** A bordered card on `surface1`. */
export function cardStyle(theme: PluginTheme, borderColor = theme.colors.border): ViewStyle {
  return {
    borderWidth: 1,
    borderColor,
    backgroundColor: theme.colors.surface1,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  };
}

/** A muted monospace id (`#01M798D7`). */
export function RunId({ theme, id }: { theme: PluginTheme; id: string }) {
  return (
    <Txt
      theme={theme}
      color={theme.colors.foregroundMuted}
      size={11}
      mono
      lines={1}
      selectable
      style={{ flexShrink: 0 }}
    >
      #{id}
    </Txt>
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
    <View
      accessibilityLabel={segments.map((segment) => segment.label).join(", ")}
      style={{ flexDirection: "row", gap: 3, alignItems: "center", flexShrink: 0 }}
    >
      {segments.map((segment) => (
        <View
          key={segment.id}
          style={{
            width: 7,
            height: 7,
            borderRadius: 2,
            backgroundColor: toneColor(theme, segment.tone),
            opacity: segment.tone === "neutral" ? 0.45 : 1,
          }}
        />
      ))}
    </View>
  );
}
