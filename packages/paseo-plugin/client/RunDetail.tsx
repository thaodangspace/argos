/**
 * The run page — GitHub-Actions-shaped: the run header with its actions, the pending gate
 * callout, the step list (one row per step, newest state), and an expandable console for the
 * selected step plus the run-level log.
 *
 * Everything is a projection of `GET /runs/:id`; the panel state machine lives in
 * `shared/panel.ts` (selection, one-shot decisions, retries).
 */

import { useEffect, useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { copyText } from "@getpaseo/plugin/client/ui";

import type {
  GateView,
  PanelStore,
  RunDetailView,
  RunView,
  StepLogEntry,
  StepView,
} from "../shared/panel";
import { buttonStyle, MONO_FONT, Pill, RunId, StatusGlyph, StepProgress, toneColor } from "./ui";
import { GateCard } from "./GateCard";

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function LogLine({ theme, entry }: { theme: PluginTheme; entry: StepLogEntry }) {
  const color =
    entry.tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, entry.tone);
  return (
    <div style={{ display: "flex", gap: 8, fontFamily: MONO_FONT, fontSize: 11, lineHeight: "17px" }}>
      <span style={{ color: theme.colors.foregroundMuted, opacity: 0.7, flexShrink: 0 }}>
        {entry.timeLabel === "" ? "        " : entry.timeLabel}
      </span>
      <span style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.text}</span>
    </div>
  );
}

function logPaneStyle(theme: PluginTheme) {
  return {
    background: theme.colors.surface0,
    border: `1px solid ${theme.colors.border}`,
    borderRadius: 6,
    padding: "8px 10px",
    maxHeight: 360,
    overflow: "auto" as const,
    marginTop: 6,
  };
}

function CopyLogButton({ theme, text }: { theme: PluginTheme; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      disabled={text === ""}
      onClick={() => {
        void copyText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      style={buttonStyle(theme, "neutral", text === "")}
    >
      {copied ? "Copied" : "Copy log"}
    </button>
  );
}

function StepLog({
  theme,
  step,
  loading,
}: {
  theme: PluginTheme;
  step: StepView;
  loading: boolean;
}) {
  return (
    <div style={logPaneStyle(theme)}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: step.log.length === 0 ? 0 : 4,
        }}
      >
        <span style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
          {loading && step.log.length === 0 ? "Loading log…" : formatLineCount(step.log.length)}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <CopyLogButton theme={theme} text={step.logText} />
        </span>
      </div>
      {step.log.length === 0 && !loading ? (
        <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.foregroundMuted }}>
          {step.status === "pending" || step.status === "ready"
            ? "This step has not run yet."
            : "Argos recorded no log lines for this step."}
        </div>
      ) : null}
      {step.log.map((entry, index) => (
        <LogLine key={`${entry.timeLabel}-${index}`} theme={theme} entry={entry} />
      ))}
      {step.kind === "agent" && step.log.length > 0 ? (
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: theme.colors.foregroundMuted,
            marginTop: 6,
            opacity: 0.8,
          }}
        >
          — agent transcripts are not stored; declared outputs only —
        </div>
      ) : null}
    </div>
  );
}

function StepRow({
  theme,
  step,
  run,
  panel,
  open,
  onToggle,
  loading,
}: {
  theme: PluginTheme;
  step: StepView;
  run: RunView;
  panel: PanelStore;
  open: boolean;
  onToggle: () => void;
  loading: boolean;
}) {
  return (
    <div style={{ borderTop: `1px solid ${theme.colors.border}`, padding: "6px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            background: "transparent",
            color: theme.colors.foreground,
            border: "none",
            padding: "2px 0",
            cursor: "pointer",
            font: "inherit",
            textAlign: "left",
          }}
        >
          <StatusGlyph theme={theme} glyph={step.glyph} tone={step.tone} />
          <span
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.title}
          </span>
          <span
            style={{
              fontSize: 10,
              color: theme.colors.foregroundMuted,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 4,
              padding: "0 4px",
            }}
          >
            {step.kindLabel}
          </span>
          {step.attemptCount > 1 ? (
            <span style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
              {step.attemptCount} attempts
            </span>
          ) : null}
          {step.errorCode === undefined ? null : (
            <span style={{ fontSize: 10, color: theme.colors.statusDanger }}>{step.errorCode}</span>
          )}
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: theme.colors.foregroundMuted,
              whiteSpace: "nowrap",
            }}
          >
            {step.durationLabel}
          </span>
          <span style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        </button>
        {step.retryable ? (
          <button
            type="button"
            disabled={run.cancelling}
            onClick={() => {
              void panel.retryStep(run.id, step.id);
            }}
            style={buttonStyle(theme, "accent", run.cancelling)}
          >
            {run.cancelling ? "Retrying…" : "Retry"}
          </button>
        ) : null}
      </div>
      {open ? <StepLog theme={theme} step={step} loading={loading} /> : null}
    </div>
  );
}

/** Remove a finished run. Two clicks, because `window.confirm` may not exist on this surface. */
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
      style={buttonStyle(theme, armed ? "danger" : "neutral", busy)}
    >
      {busy && removing ? "Removing…" : armed ? "Confirm remove" : "Remove"}
    </button>
  );
}

function defaultOpenStep(run: RunView): string | null {
  const failed = run.steps.find((step) => step.status === "failed");
  if (failed !== undefined) return failed.id;
  const running = run.steps.find((step) => step.status === "running");
  if (running !== undefined) return running.id;
  const waiting = run.steps.find((step) => step.status === "waiting");
  if (waiting !== undefined) return waiting.id;
  return null;
}

function MetaItem({ theme, label, value }: { theme: PluginTheme; label: string; value: string }) {
  return (
    <span style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
      {label} <span style={{ color: theme.colors.foreground }}>{value}</span>
    </span>
  );
}

function RunMeta({ theme, run }: { theme: PluginTheme; run: RunView }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 6 }}>
      <MetaItem theme={theme} label="trigger" value={run.triggerLabel} />
      <MetaItem theme={theme} label="started" value={run.createdLabel} />
      <MetaItem theme={theme} label="duration" value={run.durationLabel} />
      <MetaItem theme={theme} label="cwd" value={run.cwd} />
      {run.worktree === undefined ? null : (
        <MetaItem theme={theme} label="worktree" value={run.worktree} />
      )}
      {run.inputs.map((input) => (
        <MetaItem key={input.name} theme={theme} label={input.name} value={input.value} />
      ))}
    </div>
  );
}

function RunLogSection({ theme, entries }: { theme: PluginTheme; entries: readonly StepLogEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
          }}
          style={{
            background: "transparent",
            color: theme.colors.foreground,
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "inherit",
            fontSize: 12,
          }}
        >
          {open ? "▾" : "▸"} Run log ({formatLineCount(entries.length)})
        </button>
        {open ? (
          <span style={{ marginLeft: "auto" }}>
            <CopyLogButton
              theme={theme}
              text={entries
                .map((entry) => (entry.at === null ? `        ${entry.text}` : `${entry.timeLabel}  ${entry.text}`))
                .join("\n")}
            />
          </span>
        ) : null}
      </div>
      {open ? (
        <div style={logPaneStyle(theme)}>
          {entries.map((entry, index) => (
            <LogLine key={`${entry.timeLabel}-${index}`} theme={theme} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PendingGates({
  theme,
  gates,
  panel,
}: {
  theme: PluginTheme;
  gates: readonly GateView[];
  panel: PanelStore;
}) {
  const pending = gates.filter((gate) => gate.status === "pending");
  if (pending.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      {pending.map((gate) => (
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
  );
}

export function RunDetailPage({
  theme,
  panel,
  detail,
  onBack,
}: {
  theme: PluginTheme;
  panel: PanelStore;
  detail: RunDetailView;
  onBack: () => void;
}) {
  const run = detail.run;
  const [openStep, setOpenStep] = useState<string | null>(() => defaultOpenStep(run));
  // A different run starts folded on its failure/running step; polls never override the user.
  useEffect(() => {
    setOpenStep(defaultOpenStep(run));
  }, [run.id]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button type="button" onClick={onBack} style={buttonStyle(theme, "neutral")}>
          ← Runs
        </button>
        <StatusGlyph theme={theme} glyph={run.glyph} tone={run.tone} size={15} />
        <strong style={{ fontSize: 15 }}>{run.playbookId}</strong>
        <RunId theme={theme} id={run.id} />
        <Pill theme={theme} label={run.statusLabel} tone={run.tone} />
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {run.active ? (
            <button
              type="button"
              disabled={run.cancelling}
              onClick={() => {
                void panel.cancelRun(run.id);
              }}
              style={buttonStyle(theme, "danger", run.cancelling)}
            >
              {run.cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          {run.removable ? (
            <RemoveRunButton theme={theme} panel={panel} runId={run.id} busy={run.cancelling} />
          ) : null}
        </span>
      </div>

      <RunMeta theme={theme} run={run} />
      <PendingGates theme={theme} gates={run.gates} panel={panel} />

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12 }}>Steps</span>
        <span style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
          {run.completedCount}/{run.stepCount} completed
          {run.skippedCount === 0 ? "" : ` · ${run.skippedCount} skipped`}
          {run.failedCount === 0 ? "" : ` · ${run.failedCount} failed`}
          {detail.loading ? " · loading log…" : ""}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <StepProgress theme={theme} segments={run.progress} />
        </span>
      </div>

      <div style={{ marginTop: 4 }}>
        {run.steps.map((step) => (
          <StepRow
            key={step.id}
            theme={theme}
            step={step}
            run={run}
            panel={panel}
            open={openStep === step.id}
            onToggle={() => {
              setOpenStep(openStep === step.id ? null : step.id);
            }}
            loading={detail.loading}
          />
        ))}
      </div>

      <RunLogSection theme={theme} entries={detail.runLog} />

      {run.after.length === 0 ? null : (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12 }}>After tasks</div>
          {run.after.map((after) => (
            <div
              key={after.id}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginTop: 3 }}
            >
              <StatusGlyph theme={theme} glyph="•" tone={after.tone} size={10} />
              <span>{after.title}</span>
              <span style={{ color: theme.colors.foregroundMuted }}>
                {after.trigger} · {after.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
