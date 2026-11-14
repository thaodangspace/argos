/**
 * `index.client.tsx` — the Paseo client half of the Argos plugin (FR28).
 *
 * Two contributions only: a sidebar row that shows the compact status (running runs + pending
 * gates) and a screen that renders the CI-style run list and run pages. All logic lives in
 * `shared/panel.ts` and the rendering in `client/`; this file wires the RPC calls and the
 * contributions.
 *
 * The panel is a project view of `argos serve` with a few actions: start a run, cancel a run,
 * retry a failed step, decide a gate. Each button calls the store exactly once, disables while the
 * call is in flight, and a failure shows the stable error code.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import type { PluginCleanup, PluginTheme } from "@getpaseo/plugin";

import { panelView, type PanelStore } from "./shared/panel";
import { usePanel } from "./client/ui";
import { ArgosScreenView } from "./client/screen";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ARGOS_SIDEBAR_ICON } from "./shared/identity";
import { acquirePanel, disposeAllPanels } from "./shared/panel-hub";
import type { ArgosRpcCalls } from "./shared/rpc-bridge";
import {
  GateDecideRpc,
  RunCancelRpc,
  RunGetRpc,
  RunRemoveRpc,
  RunRetryRpc,
  RunStartRpc,
  RunsListRpc,
} from "./shared/rpc-api";
import { Pill, Txt } from "./client/ui";

export const ARGOS_SCREEN_ID = "argos";
export const ARGOS_SIDEBAR_ITEM_ID = "argos";

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
  const removeRun = useRpc(RunRemoveRpc);
  const retryStep = useRpc(RunRetryRpc);
  const decideGate = useRpc(GateDecideRpc);
  const [state, setState] = useState<{
    readonly panel: PanelStore | null;
    readonly error: string | null;
  }>({ panel: null, error: null });

  useEffect(() => {
    const calls: ArgosRpcCalls = {
      listRuns,
      getRun,
      startRun,
      cancelRun,
      removeRun,
      retryStep,
      decideGate,
    };
    const lease = acquirePanel(calls);
    setState({ panel: lease.panel, error: null });
    return () => lease.release();
  }, [listRuns, getRun, startRun, cancelRun, removeRun, retryStep, decideGate]);

  return state;
}

function LoadingPanel({ theme, error }: { theme: PluginTheme; error: string | null }) {
  return (
    <View style={{ flex: 1, padding: 12, backgroundColor: theme.colors.surface0 }}>
      <Txt theme={theme} color={theme.colors.foregroundMuted} size={12}>
        {error ?? "Connecting to Argos…"}
      </Txt>
    </View>
  );
}

function ArgosSidebarTrailing({
  theme,
  running,
  pendingGates,
  error,
}: {
  theme: PluginTheme;
  running: number;
  pendingGates: number;
  error: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {error ? <Pill theme={theme} label="not running" tone="danger" /> : null}
      {running === 0 ? null : <Pill theme={theme} label={`${running} running`} tone="success" />}
      {pendingGates === 0 ? null : (
        <Pill theme={theme} label={`${pendingGates} waiting`} tone="warning" />
      )}
    </View>
  );
}

function ArgosSidebarView({
  theme,
  panel,
  openScreen,
  currentScreen,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  openScreen: PluginSidebarItemProps["openScreen"];
  currentScreen: PluginSidebarItemProps["currentScreen"];
}) {
  const view = panelView(usePanel(panel));
  return (
    <SidebarRow
      icon={ARGOS_SIDEBAR_ICON}
      active={currentScreen?.screenId === ARGOS_SCREEN_ID}
      onPress={() => {
        openScreen({ screenId: ARGOS_SCREEN_ID });
      }}
      trailing={
        <ArgosSidebarTrailing
          theme={theme}
          running={view.running}
          pendingGates={view.pendingGates}
          error={view.error !== null}
        />
      }
    />
  );
}

function ArgosScreen({ theme }: PluginScreenProps) {
  const { panel, error } = useArgosPanel();
  if (panel === null) return <LoadingPanel theme={theme} error={error} />;
  return <ArgosScreenView theme={theme} panel={panel} />;
}

function ArgosSidebar({ theme, openScreen, currentScreen }: PluginSidebarItemProps) {
  const { panel, error } = useArgosPanel();
  if (panel === null) {
    return (
      <SidebarRow
        icon={ARGOS_SIDEBAR_ICON}
        active={currentScreen?.screenId === ARGOS_SCREEN_ID}
        onPress={() => {
          openScreen({ screenId: ARGOS_SCREEN_ID });
        }}
        trailing={
          <Pill
            theme={theme}
            label={error === null ? "connecting" : "not running"}
            tone={error === null ? "neutral" : "danger"}
          />
        }
      />
    );
  }
  return (
    <ArgosSidebarView
      theme={theme}
      panel={panel}
      openScreen={openScreen}
      currentScreen={currentScreen}
    />
  );
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
