/** Pending-gate callout: the question, the comment box, and one button per choice. */

import { useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";

import type { GateView } from "../shared/panel";
import { buttonStyle, toneColor } from "./ui";

export function GateCard({
  theme,
  gate,
  onDecide,
}: {
  theme: PluginTheme;
  gate: GateView;
  onDecide: (decision: string, comment: string | undefined) => void;
}) {
  const [comment, setComment] = useState("");
  return (
    <div
      style={{
        border: `1px solid ${toneColor(theme, "warning")}`,
        background: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
      }}
    >
      <div style={{ fontSize: 12, color: theme.colors.foreground }}>{gate.question}</div>
      <div style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 2 }}>
        {gate.gateId} · step {gate.stepId} · {gate.kind}
      </div>
      <input
        value={comment}
        placeholder="comment (optional)"
        onChange={(event) => {
          setComment(event.target.value);
        }}
        style={{
          marginTop: 6,
          width: "100%",
          background: theme.colors.surface0,
          color: theme.colors.foreground,
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 6,
          padding: "4px 6px",
          fontSize: 12,
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {gate.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            disabled={gate.deciding}
            onClick={() => {
              onDecide(choice.id, comment === "" ? undefined : comment);
            }}
            style={buttonStyle(theme, choice.tone, gate.deciding)}
          >
            {gate.deciding ? `${choice.label}…` : choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
