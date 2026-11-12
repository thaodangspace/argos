/**
 * `index.client.tsx` — the Paseo client half of the Argos plugin (FR28).
 *
 * Two contributions only: a sidebar row that shows the compact status (running runs + pending
 * gates) and a screen that lists runs with their steps and pending-gate buttons. All logic lives in
 * `shared/panel.ts`; this file is rendering plus theme tokens from `@getpaseo/plugin/client` props.
 *
 * The panel is a project view of `argos serve` with a few actions: start a run, cancel a run,
 * retry a failed step, decide a gate. Each button calls the store exactly once, disables while the
 * call is in flight, and a failure shows the stable error code.
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
  parseStartForm,
  type GateView,
  type PanelModel,
  type PanelStore,
  type PanelView,
  type StatusTone,
} from "./shared/panel";
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

function smallButton(theme: PluginTheme, color: string, disabled: boolean) {
  return {
    background: theme.colors.surface0,
    color,
    border: `1px solid ${theme.colors.border}`,
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  } as const;
}

/**
 * Remove a finished run. Two clicks, because the panel may render where `window.confirm` does not
 * exist (React Native): the first arms the button, the second within 4 s removes the run.
 */
function RemoveRunButton({
  theme,
  panel,
  runId,
  busy,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  runId: string;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);
  // `busy` also covers a retry of this run; only label the button when it is the remove in flight.
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={busy}
      title="Delete this run from Argos (its worktree, if any, is kept)"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        setRemoving(true);
        void panel.removeRun(runId).finally(() => setRemoving(false));
      }}
      style={{
        ...smallButton(theme, armed ? theme.colors.statusDanger : theme.colors.foregroundMuted, busy),
        marginLeft: "auto",
      }}
    >
      {busy && removing ? "Removing…" : armed ? "Confirm remove" : "Remove"}
    </button>
  );
}

function fieldStyle(theme: PluginTheme) {
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

/** Collapsible "Start run" form: playbook id, optional cwd, inputs as key=value lines or JSON. */
function StartRunForm({
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
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        style={{ ...smallButton(theme, theme.colors.accent, false), marginTop: 10 }}
      >
        + Start run
      </button>
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

  return (
    <div
      style={{
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface1,
        borderRadius: 8,
        padding: 10,
        marginTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 12 }}>Start run</strong>
      <input
        value={playbookId}
        placeholder="playbook id (file name without .yaml)"
        onChange={(event) => {
          setPlaybookId(event.target.value);
        }}
        style={fieldStyle(theme)}
      />
      <input
        value={cwd}
        placeholder="cwd (optional, default: the server's cwd)"
        onChange={(event) => {
          setCwd(event.target.value);
        }}
        style={fieldStyle(theme)}
      />
      <textarea
        value={inputs}
        rows={3}
        placeholder={'inputs: key=value per line, or {"key": 1}'}
        onChange={(event) => {
          setInputs(event.target.value);
        }}
        style={{ ...fieldStyle(theme), fontFamily: "monospace", resize: "vertical" }}
      />
      {formError === null ? null : (
        <div style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{formError}</div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          disabled={starting}
          onClick={submit}
          style={smallButton(theme, theme.colors.accent, starting)}
        >
          {starting ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          disabled={starting}
          onClick={() => {
            setOpen(false);
            setFormError(null);
          }}
          style={smallButton(theme, theme.colors.foregroundMuted, starting)}
        >
          Close
        </button>
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
          No Argos runs yet. Start one below, or ask an agent to use argos_start_playbook.
        </div>
      ) : null}

      <StartRunForm theme={theme} panel={panel} starting={model.starting} />

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
            {run.removable ? (
              <RemoveRunButton
                theme={theme}
                panel={panel}
                runId={run.id}
                busy={run.cancelling}
              />
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
                {step.retryable ? (
                  <button
                    type="button"
                    disabled={run.cancelling}
                    onClick={() => {
                      void panel.retryStep(run.id, step.id);
                    }}
                    style={{
                      ...smallButton(theme, theme.colors.accent, run.cancelling),
                      marginLeft: "auto",
                      padding: "0 8px",
                    }}
                  >
                    {run.cancelling ? "Retrying…" : "Retry"}
                  </button>
                ) : null}
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
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {error ? <Pill theme={theme} label="not running" tone="danger" /> : null}
      {running === 0 ? null : <Pill theme={theme} label={`${running} running`} tone="success" />}
      {pendingGates === 0 ? null : (
        <Pill theme={theme} label={`${pendingGates} waiting`} tone="warning" />
      )}
    </span>
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
