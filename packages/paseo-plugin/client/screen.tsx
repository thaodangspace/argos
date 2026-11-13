/**
 * The Argos screen: a header (live state, refresh, start), the error banner, and either the run
 * list or one run's CI page. All state comes from `panelView`; every action is a store call.
 */

import type { PluginTheme } from "@getpaseo/plugin";

import type { PanelStore } from "../shared/panel";
import { panelView } from "../shared/panel";
import { buttonStyle, Pill, usePanel } from "./ui";
import { RunDetailPage } from "./RunDetail";
import { RunList } from "./RunList";
import { StartRunForm } from "./StartRunForm";

export function ArgosScreenView({ theme, panel }: { theme: PluginTheme; panel: PanelStore }) {
  const model = usePanel(panel);
  const view = panelView(model);
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: theme.colors.surface0,
        color: theme.colors.foreground,
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Argos</strong>
        <Pill theme={theme} label={view.statusLabel} tone={view.statusTone} />
        <span style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{view.heading}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              if (view.selected === null) void panel.load();
              else void panel.selectRun(view.selected.run.id);
            }}
            style={buttonStyle(theme, "neutral")}
          >
            Refresh
          </button>
        </span>
      </div>

      <div style={{ marginTop: 8 }}>
        <StartRunForm theme={theme} panel={panel} starting={model.starting} />
      </div>

      {view.error === null ? null : (
        <div style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 8 }}>
          {view.error.code}: {view.error.message}
        </div>
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
    </div>
  );
}
