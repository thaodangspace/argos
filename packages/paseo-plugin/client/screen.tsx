/**
 * The Argos screen: a header (live state, refresh, start), the error banner, and either the run
 * list or one run's CI page. All state comes from `panelView`; every action is a store call.
 */

import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/ui";

import type { PanelStore } from "../shared/panel";
import { panelView } from "../shared/panel";
import { Button, Pill, Row, Txt, usePanel } from "./ui";
import { RunDetailPage } from "./RunDetail";
import { RunList } from "./RunList";
import { StartRunForm } from "./StartRunForm";

export function ArgosScreenView({ theme, panel }: { theme: PluginTheme; panel: PanelStore }) {
  const model = usePanel(panel);
  const view = panelView(model);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 12 }}
    >
      <Row gap={8} wrap>
        <Txt theme={theme} size={14} bold>
          Argos
        </Txt>
        <Pill theme={theme} label={view.statusLabel} tone={view.statusTone} />
        <Txt theme={theme} color={theme.colors.foregroundMuted} size={12} style={{ flexShrink: 1 }}>
          {view.heading}
        </Txt>
        <Row style={{ marginLeft: "auto" }}>
          <Button
            theme={theme}
            tone="neutral"
            label="Refresh"
            onPress={() => {
              if (view.selected === null) void panel.load();
              else void panel.selectRun(view.selected.run.id);
            }}
          />
        </Row>
      </Row>

      <View style={{ marginTop: 8 }}>
        <StartRunForm theme={theme} panel={panel} starting={model.starting} />
      </View>

      {view.error === null ? null : (
        <Txt theme={theme} color={theme.colors.statusDanger} size={12} selectable style={{ marginTop: 8 }}>
          {view.error.code}: {view.error.message}
        </Txt>
      )}

      {view.selected === null ? (
        <RunList
          theme={theme}
          view={view}
          onOpen={(runId) => {
            void panel.selectRun(runId);
          }}
          onFilter={(filter) => {
            panel.setFilter(filter);
          }}
        />
      ) : (
        <RunDetailPage
          theme={theme}
          panel={panel}
          detail={view.selected}
          onBack={() => {
            panel.closeRun();
          }}
        />
      )}
    </ScrollView>
  );
}
