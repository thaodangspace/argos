/**
 * `index.client.tsx` — the Paseo client half of the Argos plugin (FR28).
 *
 * Two contributions only: a sidebar row that shows the compact status (running runs + pending
 * gates) and a screen that lists runs with their steps and pending-gate buttons. All logic lives in
 * `shared/panel.ts`; this file is rendering plus theme tokens from `@getpaseo/plugin/client` props.
 *
 * The panel is a read/project view of `argos serve`: a decision button calls the store exactly
 * once, the button disables while the call is in flight, and a failure shows the stable error code.
 */

import { useEffect, useState } from "react";
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import type { PluginCleanup, PluginTheme } from "@getpaseo/plugin";

import {
  panelView,
  type GateView,
  type PanelModel,
  type PanelStore,
  type PanelView,
  type StatusTone,
} from "./shared/panel";
import { useRpc } from "@getpaseo/plugin/client";
import { acquirePanel, disposeAllPanels } from "./shared/panel-hub";
import type { ArgosRpcCalls } from "./shared/rpc-bridge";
import {
  GateDecideRpc,
  RunCancelRpc,
  RunGetRpc,
  RunStartRpc,
  RunsListRpc,
} from "./shared/rpc-api";

export const ARGOS_SCREEN_ID = "argos";
export const ARGOS_SIDEBAR_ITEM_ID = "argos";

function toneColor(theme: PluginTheme, tone: StatusTone): string {
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
function usePanel(panel: PanelStore): PanelModel {
  const [model, setModel] = useState<PanelModel>(() => panel.getModel());
  useEffect(() => panel.subscribe(setModel), [panel]);
  return model;
}

/**
 * Lease the shared panel over the plugin RPC channel. The Paseo client bundle never reads the
 * token and never calls `argos serve` directly: the plugin's server half does both, so this works
 * across remote hosts and browser CORS.
 */
function useArgosPanel(): { readonly panel: PanelStore | null; readonly error: string | null } {
  const listRuns = useRpc(RunsListRpc);
  const getRun = useRpc(RunGetRpc);
  const startRun = useRpc(RunStartRpc);
  const cancelRun = useRpc(RunCancelRpc);
  const decideGate = useRpc(GateDecideRpc);
  const [state, setState] = useState<{
    readonly panel: PanelStore | null;
    readonly error: string | null;
  }>({ panel: null, error: null });

  useEffect(() => {
    const calls: ArgosRpcCalls = { listRuns, getRun, startRun, cancelRun, decideGate };
    const lease = acquirePanel(calls);
    setState({ panel: lease.panel, error: null });
    return () => lease.release();
  }, [listRuns, getRun, startRun, cancelRun, decideGate]);

  return state;
}

function LoadingPanel({ theme, error }: { theme: PluginTheme; error: string | null }) {
  return (
    <div style={{ color: theme.colors.foregroundMuted, padding: 12, fontSize: 12 }}>
      {error ?? "Connecting to Argos…"}
    </div>
  );
}

function Pill({
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
      }}
    >
      {label}
    </span>
  );
}

function GateCard({
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
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
      }}
    >
      <div style={{ color: theme.colors.foreground, fontSize: 13 }}>{gate.question}</div>
      <div style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
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
            style={{
              cursor: gate.deciding ? "default" : "pointer",
              opacity: gate.deciding ? 0.5 : 1,
              background: theme.colors.surface0,
              color: toneColor(theme, choice.tone),
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
            }}
          >
            {gate.deciding ? `${choice.label}…` : choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ArgosScreenView({ theme, panel }: { theme: PluginTheme; panel: PanelStore }) {
  const model = usePanel(panel);
  const view: PanelView = panelView(model);
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: theme.colors.surface0,
        color: theme.colors.foreground,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Argos</strong>
        <Pill theme={theme} label={view.statusLabel} tone={view.statusTone} />
        <span style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{view.heading}</span>
        <button
          type="button"
          onClick={() => {
            void panel.load();
          }}
          style={{
            marginLeft: "auto",
            background: theme.colors.surface1,
            color: theme.colors.foreground,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 6,
            padding: "2px 8px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {view.error === null ? null : (
        <div style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 8 }}>
          {view.error.code}: {view.error.message}
        </div>
      )}

      {view.empty ? (
        <div style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 12 }}>
          No Argos runs yet. Ask an agent to start one with argos_start_playbook.
        </div>
      ) : null}

      {view.runs.map((run) => (
        <div
          key={run.id}
          style={{
            border: `1px solid ${theme.colors.border}`,
            background: theme.colors.surface1,
            borderRadius: 8,
            padding: 10,
            marginTop: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>{run.playbookId}</span>
            <Pill theme={theme} label={run.statusLabel} tone={run.tone} />
            <span style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {run.updatedLabel}
            </span>
            {run.active ? (
              <button
                type="button"
                disabled={run.cancelling}
                onClick={() => {
                  void panel.cancelRun(run.id);
                }}
                style={{
                  marginLeft: "auto",
                  background: theme.colors.surface0,
                  color: theme.colors.statusDanger,
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: 11,
                  cursor: run.cancelling ? "default" : "pointer",
                  opacity: run.cancelling ? 0.5 : 1,
                }}
              >
                {run.cancelling ? "Cancelling…" : "Cancel"}
              </button>
            ) : null}
          </div>
          <div style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 2 }}>
            {run.detail} · {run.id}
          </div>

          <div style={{ marginTop: 8 }}>
            {run.steps.map((step) => (
              <div
                key={step.id}
                style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: "20px" }}
              >
                <span style={{ color: toneColor(theme, step.tone), minWidth: 96 }}>
                  {step.statusLabel}
                </span>
                <span style={{ color: theme.colors.foreground }}>{step.title}</span>
                <span style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {step.kindLabel}
                  {step.attemptCount > 1 ? ` · ${step.attemptCount} attempts` : ""}
                  {step.errorCode === undefined ? "" : ` · ${step.errorCode}`}
                </span>
              </div>
            ))}
          </div>

          {run.gates
            .filter((gate) => gate.status === "pending")
            .map((gate) => (
              <GateCard
                key={gate.key}
                theme={theme}
                gate={gate}
                onDecide={(decision, comment) => {
                  void panel.decideGate({
                    runId: gate.runId,
                    gateId: gate.gateId,
                    decision,
                    ...(comment === undefined ? {} : { comment }),
                  });
                }}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

function ArgosSidebarView({
  theme,
  panel,
  openScreen,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  openScreen: PluginSidebarItemProps["openScreen"];
}) {
  const view = panelView(usePanel(panel));
  return (
    <button
      type="button"
      onClick={() => {
        openScreen({ screenId: ARGOS_SCREEN_ID });
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        background: "transparent",
        color: theme.colors.foreground,
        border: "none",
        padding: "4px 6px",
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <span>Argos</span>
      {view.error === null ? null : (
        <Pill theme={theme} label="Argos server not running" tone="danger" />
      )}
      {view.running === 0 ? null : <Pill theme={theme} label={`${view.running} running`} tone="success" />}
      {view.pendingGates === 0 ? null : (
        <Pill theme={theme} label={`${view.pendingGates} waiting`} tone="warning" />
      )}
    </button>
  );
}

function ArgosScreen({ theme }: PluginScreenProps) {
  const { panel, error } = useArgosPanel();
  if (panel === null) return <LoadingPanel theme={theme} error={error} />;
  return <ArgosScreenView theme={theme} panel={panel} />;
}

function ArgosSidebar({ theme, openScreen }: PluginSidebarItemProps) {
  const { panel, error } = useArgosPanel();
  if (panel === null) {
    return (
      <button
        type="button"
        onClick={() => {
          openScreen({ screenId: ARGOS_SCREEN_ID });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "transparent",
          color: theme.colors.foreground,
          border: "none",
          padding: "4px 6px",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        <span>Argos</span>
        <Pill
          theme={theme}
          label={error === null ? "connecting" : "server not running"}
          tone={error === null ? "neutral" : "danger"}
        />
      </button>
    );
  }
  return <ArgosSidebarView theme={theme} panel={panel} openScreen={openScreen} />;
}

/** Install the sidebar row and the screen; both are removed (and the client closed) on cleanup. */
export default function contribute(client: PluginClientContext): PluginCleanup {
  function Screen(props: PluginScreenProps) {
    return <ArgosScreen {...props} />;
  }

  function Sidebar(props: PluginSidebarItemProps) {
    return <ArgosSidebar {...props} />;
  }

  const removeScreen = client.addScreen({
    id: ARGOS_SCREEN_ID,
    title: "Argos",
    Component: Screen,
  });
  const removeItem = client.addSidebarHeaderItem({
    id: ARGOS_SIDEBAR_ITEM_ID,
    title: "Argos",
    Component: Sidebar,
  });

  return () => {
    removeItem();
    removeScreen();
    disposeAllPanels();
  };
}
