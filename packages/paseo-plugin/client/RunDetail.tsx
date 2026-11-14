/**
 * The run page — GitHub-Actions-shaped: the run header with its actions, the pending gate
 * callout, the step list (one row per step, newest state), and an expandable console for the
 * selected step plus the run-level log.
 *
 * Everything is a projection of `GET /runs/:id`; the panel state machine lives in
 * `shared/panel.ts` (selection, one-shot decisions, retries).
 */

import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, ScrollView } from "@getpaseo/plugin/client/ui";

import type {
  GateView,
  PanelStore,
  RunDetailView,
  RunView,
  StepLogEntry,
  StepView,
} from "../shared/panel";
import {
  Button,
  Pill,
  PressableRow,
  Row,
  RunId,
  StatusGlyph,
  StepProgress,
  toneColor,
  Txt,
} from "./ui";
import { GateCard } from "./GateCard";

function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function LogLine({ theme, entry }: { theme: PluginTheme; entry: StepLogEntry }) {
  const color =
    entry.tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, entry.tone);
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Txt
        theme={theme}
        color={theme.colors.foregroundMuted}
        size={11}
        mono
        style={{ lineHeight: 17, opacity: 0.7, flexShrink: 0 }}
      >
        {entry.timeLabel === "" ? "        " : entry.timeLabel}
      </Txt>
      <Txt theme={theme} color={color} size={11} mono selectable style={{ lineHeight: 17, flex: 1 }}>
        {entry.text}
      </Txt>
    </View>
  );
}

/** A bounded, scrollable console pane (nested scrolling stays inside it on mobile). */
function LogPane({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <ScrollView
      nestedScrollEnabled
      style={{
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        maxHeight: 360,
        marginTop: 6,
      }}
      contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}
    >
      {children}
    </ScrollView>
  );
}

function CopyLogButton({ theme, text }: { theme: PluginTheme; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      theme={theme}
      tone="neutral"
      label={copied ? "Copied" : "Copy log"}
      disabled={text === ""}
      onPress={() => {
        void copyText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    />
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
  const muted = theme.colors.foregroundMuted;
  return (
    <LogPane theme={theme}>
      <Row gap={8} style={{ marginBottom: step.log.length === 0 ? 0 : 4 }}>
        <Txt theme={theme} color={muted} size={11}>
          {loading && step.log.length === 0 ? "Loading log…" : formatLineCount(step.log.length)}
        </Txt>
        <View style={{ marginLeft: "auto" }}>
          <CopyLogButton theme={theme} text={step.logText} />
        </View>
      </Row>
      {step.log.length === 0 && !loading ? (
        <Txt theme={theme} color={muted} size={11} mono>
          {step.status === "pending" || step.status === "ready"
            ? "This step has not run yet."
            : "Argos recorded no log lines for this step."}
        </Txt>
      ) : null}
      {step.log.map((entry, index) => (
        <LogLine key={`${entry.timeLabel}-${index}`} theme={theme} entry={entry} />
      ))}
      {step.kind === "agent" && step.log.length > 0 ? (
        <Txt theme={theme} color={muted} size={10} mono style={{ marginTop: 6, opacity: 0.8 }}>
          — agent transcripts are not stored; declared outputs only —
        </Txt>
      ) : null}
    </LogPane>
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
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 6 }}>
      <Row gap={8}>
        <PressableRow
          accessibilityLabel={`${step.title}, ${step.kindLabel}`}
          expanded={open}
          onPress={onToggle}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            paddingVertical: 2,
          }}
        >
          <StatusGlyph theme={theme} glyph={step.glyph} tone={step.tone} />
          <Txt theme={theme} size={12} lines={1} style={{ flexShrink: 1 }}>
            {step.title}
          </Txt>
          <View
            style={{
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 4,
              paddingHorizontal: 4,
            }}
          >
            <Txt theme={theme} color={muted} size={10} lines={1}>
              {step.kindLabel}
            </Txt>
          </View>
          {step.attemptCount > 1 ? (
            <Txt theme={theme} color={muted} size={10} lines={1}>
              {step.attemptCount} attempts
            </Txt>
          ) : null}
          {step.errorCode === undefined ? null : (
            <Txt theme={theme} color={theme.colors.statusDanger} size={10} lines={1}>
              {step.errorCode}
            </Txt>
          )}
          <Txt theme={theme} color={muted} size={11} lines={1} style={{ marginLeft: "auto" }}>
            {step.durationLabel}
          </Txt>
          <Txt theme={theme} color={muted} size={10}>
            {open ? "▾" : "▸"}
          </Txt>
        </PressableRow>
        {step.retryable ? (
          <Button
            theme={theme}
            tone="accent"
            label={run.cancelling ? "Retrying…" : "Retry"}
            disabled={run.cancelling}
            onPress={() => {
              void panel.retryStep(run.id, step.id);
            }}
          />
        ) : null}
      </Row>
      {open ? <StepLog theme={theme} step={step} loading={loading} /> : null}
    </View>
  );
}

/** Remove a finished run. Two presses, because `window.confirm` does not exist on native. */
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
    <Button
      theme={theme}
      tone={armed ? "danger" : "neutral"}
      label={busy && removing ? "Removing…" : armed ? "Confirm remove" : "Remove"}
      accessibilityLabel="Delete this run from Argos (its worktree, if any, is kept)"
      disabled={busy}
      onPress={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        setRemoving(true);
        void panel.removeRun(runId).finally(() => setRemoving(false));
      }}
    />
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
    <Txt theme={theme} color={theme.colors.foregroundMuted} size={11} selectable>
      {label} <Txt theme={theme}>{value}</Txt>
    </Txt>
  );
}

function RunMeta({ theme, run }: { theme: PluginTheme; run: RunView }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 4, columnGap: 14, marginTop: 6 }}>
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
    </View>
  );
}

function RunLogSection({ theme, entries }: { theme: PluginTheme; entries: readonly StepLogEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Row gap={8}>
        <PressableRow
          expanded={open}
          onPress={() => {
            setOpen(!open);
          }}
        >
          <Txt theme={theme} size={12}>
            {open ? "▾" : "▸"} Run log ({formatLineCount(entries.length)})
          </Txt>
        </PressableRow>
        {open ? (
          <View style={{ marginLeft: "auto" }}>
            <CopyLogButton
              theme={theme}
              text={entries
                .map((entry) => (entry.at === null ? `        ${entry.text}` : `${entry.timeLabel}  ${entry.text}`))
                .join("\n")}
            />
          </View>
        ) : null}
      </Row>
      {open ? (
        <LogPane theme={theme}>
          {entries.map((entry, index) => (
            <LogLine key={`${entry.timeLabel}-${index}`} theme={theme} entry={entry} />
          ))}
        </LogPane>
      ) : null}
    </View>
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
    <View style={{ marginTop: 10 }}>
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
    </View>
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
  const muted = theme.colors.foregroundMuted;
  const [openStep, setOpenStep] = useState<string | null>(() => defaultOpenStep(run));
  // A different run starts folded on its failure/running step; polls never override the user.
  useEffect(() => {
    setOpenStep(defaultOpenStep(run));
  }, [run.id]);

  return (
    <View>
      <Row gap={8} wrap style={{ marginTop: 10 }}>
        <Button theme={theme} tone="neutral" label="← Runs" onPress={onBack} />
        <StatusGlyph theme={theme} glyph={run.glyph} tone={run.tone} size={15} />
        <Txt theme={theme} size={15} bold lines={1} style={{ flexShrink: 1 }}>
          {run.playbookId}
        </Txt>
        <RunId theme={theme} id={run.id} />
        <Pill theme={theme} label={run.statusLabel} tone={run.tone} />
        <Row wrap style={{ marginLeft: "auto" }}>
          {run.active ? (
            <Button
              theme={theme}
              tone="danger"
              label={run.cancelling ? "Cancelling…" : "Cancel"}
              disabled={run.cancelling}
              onPress={() => {
                void panel.cancelRun(run.id);
              }}
            />
          ) : null}
          {run.removable ? (
            <RemoveRunButton theme={theme} panel={panel} runId={run.id} busy={run.cancelling} />
          ) : null}
        </Row>
      </Row>

      <RunMeta theme={theme} run={run} />
      <PendingGates theme={theme} gates={run.gates} panel={panel} />

      <Row gap={8} style={{ marginTop: 12 }}>
        <Txt theme={theme} size={12}>
          Steps
        </Txt>
        <Txt theme={theme} color={muted} size={11} style={{ flexShrink: 1 }}>
          {run.completedCount}/{run.stepCount} completed
          {run.skippedCount === 0 ? "" : ` · ${run.skippedCount} skipped`}
          {run.failedCount === 0 ? "" : ` · ${run.failedCount} failed`}
          {detail.loading ? " · loading log…" : ""}
        </Txt>
        <View style={{ marginLeft: "auto" }}>
          <StepProgress theme={theme} segments={run.progress} />
        </View>
      </Row>

      <View style={{ marginTop: 4 }}>
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
      </View>

      <RunLogSection theme={theme} entries={detail.runLog} />

      {run.after.length === 0 ? null : (
        <View style={{ marginTop: 10 }}>
          <Txt theme={theme} size={12}>
            After tasks
          </Txt>
          {run.after.map((after) => (
            <Row key={after.id} gap={8} style={{ marginTop: 3 }}>
              <StatusGlyph theme={theme} glyph="•" tone={after.tone} size={10} />
              <Txt theme={theme} size={11} lines={1} style={{ flexShrink: 1 }}>
                {after.title}
              </Txt>
              <Txt theme={theme} color={muted} size={11} lines={1}>
                {after.trigger} · {after.status}
              </Txt>
            </Row>
          ))}
        </View>
      )}
    </View>
  );
}
