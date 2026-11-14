/** Pending-gate callout: the question, the comment box, and one button per choice. */

import { useState } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";

import type { GateView } from "../shared/panel";
import { Button, cardStyle, fieldStyle, Row, toneColor, Txt } from "./ui";

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
    <View style={cardStyle(theme, toneColor(theme, "warning"))}>
      <Txt theme={theme} size={12} selectable>
        {gate.question}
      </Txt>
      <Txt theme={theme} color={theme.colors.foregroundMuted} size={11} style={{ marginTop: 2 }}>
        {gate.gateId} · step {gate.stepId} · {gate.kind}
      </Txt>
      <TextInput
        value={comment}
        placeholder="comment (optional)"
        placeholderTextColor={theme.colors.foregroundMuted}
        onChangeText={setComment}
        style={[fieldStyle(theme), { marginTop: 6 }]}
      />
      <Row wrap style={{ marginTop: 8 }}>
        {gate.choices.map((choice) => (
          <Button
            key={choice.id}
            theme={theme}
            tone={choice.tone}
            label={gate.deciding ? `${choice.label}…` : choice.label}
            disabled={gate.deciding}
            onPress={() => {
              onDecide(choice.id, comment === "" ? undefined : comment);
            }}
          />
        ))}
      </Row>
    </View>
  );
}
