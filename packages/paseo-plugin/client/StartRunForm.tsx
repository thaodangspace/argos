/** Collapsible "Start run" form: playbook id, optional cwd, inputs as key=value lines or JSON. */

import { useState } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/ui";

import { parseStartForm, type PanelStore } from "../shared/panel";
import { Button, cardStyle, fieldStyle, MONO_FONT, Row, Txt } from "./ui";

export function StartRunForm({
  theme,
  panel,
  starting,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  starting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [playbookId, setPlaybookId] = useState("");
  const [cwd, setCwd] = useState("");
  const [inputs, setInputs] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        theme={theme}
        tone="accent"
        label="+ New run"
        style={{ alignSelf: "flex-start" }}
        onPress={() => {
          setOpen(true);
        }}
      />
    );
  }

  const submit = (): void => {
    const parsed = parseStartForm({ playbookId, cwd, inputs });
    if (!parsed.ok) {
      setFormError(parsed.error.message);
      return;
    }
    setFormError(null);
    void panel.startRun(parsed.request).then((outcome) => {
      if (outcome.started !== undefined) {
        setOpen(false);
        setPlaybookId("");
        setInputs("");
      }
    });
  };

  const field = fieldStyle(theme);
  return (
    <View style={[cardStyle(theme), { marginTop: 10, gap: 6 }]}>
      <Txt theme={theme} size={12} bold>
        Start run
      </Txt>
      <TextInput
        value={playbookId}
        placeholder="playbook id (file name without .yaml)"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setPlaybookId}
        style={field}
      />
      <TextInput
        value={cwd}
        placeholder="cwd (optional, default: the server's cwd)"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setCwd}
        style={field}
      />
      <TextInput
        value={inputs}
        multiline
        numberOfLines={3}
        placeholder={'inputs: key=value per line, or {"key": 1}'}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setInputs}
        style={[field, { fontFamily: MONO_FONT, minHeight: 60, textAlignVertical: "top" }]}
      />
      {formError === null ? null : (
        <Txt theme={theme} color={theme.colors.statusDanger} size={11}>
          {formError}
        </Txt>
      )}
      <Row>
        <Button
          theme={theme}
          tone="accent"
          label={starting ? "Starting…" : "Start"}
          disabled={starting}
          onPress={submit}
        />
        <Button
          theme={theme}
          tone="neutral"
          label="Close"
          disabled={starting}
          onPress={() => {
            setOpen(false);
            setFormError(null);
          }}
        />
      </Row>
    </View>
  );
}
