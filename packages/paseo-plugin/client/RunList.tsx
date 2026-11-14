/**
 * The CI-style run list: filter chips, then one collapsible group per playbook.
 *
 * A schedule fires the same playbook every hour, so the list groups by workflow instead of
 * printing a wall of identical cards; only the newest runs of a group are shown until asked.
 */

import { useState } from "react";
import { View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

import type { PanelView, RunView, WorkflowGroupView } from "../shared/panel";
import {
  Button,
  cardStyle,
  Pill,
  PressableRow,
  Row,
  RunId,
  StatusGlyph,
  StepProgress,
  toneColor,
  Txt,
} from "./ui";

const RUNS_PER_GROUP = 5;

function RunRow({
  theme,
  run,
  onOpen,
}: {
  theme: PluginTheme;
  run: RunView;
  onOpen: (runId: string) => void;
}) {
  const muted = theme.colors.foregroundMuted;
  return (
    <PressableRow
      accessibilityLabel={`${run.playbookId} ${run.runIdShort} ${run.statusLabel}`}
      onPress={() => onOpen(run.id)}
      style={{
        gap: 3,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 7,
      }}
    >
      <Row>
        <StatusGlyph theme={theme} glyph={run.glyph} tone={run.tone} />
        <Txt theme={theme} size={13} lines={1} style={{ flexShrink: 1 }}>
          {run.playbookId}
        </Txt>
        <RunId theme={theme} id={run.runIdShort} />
        <Pill theme={theme} label={run.statusLabel} tone={run.tone} />
        <Txt theme={theme} color={muted} size={11} lines={1} style={{ marginLeft: "auto" }}>
          {run.durationLabel}
        </Txt>
      </Row>
      <Row>
        <Txt theme={theme} color={muted} size={11} lines={1} style={{ flexShrink: 1 }}>
          {run.triggerLabel} · {run.updatedRelative} · {run.detail}
        </Txt>
        <Row style={{ marginLeft: "auto" }}>
          <StepProgress theme={theme} segments={run.progress} />
          <Txt theme={theme} color={muted} size={11} lines={1}>
            {run.completedCount}/{run.stepCount}
          </Txt>
        </Row>
      </Row>
    </PressableRow>
  );
}

function groupSummary(group: WorkflowGroupView): string {
  const parts = [`${group.total} run${group.total === 1 ? "" : "s"}`];
  if (group.active > 0) parts.push(`${group.active} active`);
  if (group.failed > 0) parts.push(`${group.failed} failed`);
  if (group.pendingGates > 0) parts.push(`${group.pendingGates} waiting`);
  return parts.join(" · ");
}

function WorkflowGroup({
  theme,
  group,
  onOpen,
}: {
  theme: PluginTheme;
  group: WorkflowGroupView;
  onOpen: (runId: string) => void;
}) {
  // A group whose newest run needs attention opens itself; the rest stay folded.
  const [open, setOpen] = useState(
    () =>
      group.latest.active ||
      group.latest.status === "failed" ||
      group.latest.status === "cancelled" ||
      group.pendingGates > 0,
  );
  const [limit, setLimit] = useState(RUNS_PER_GROUP);
  const shown = group.runs.slice(0, limit);
  const hidden = group.total - shown.length;
  // A one-run workflow needs no fold: the header row opens it directly.
  const single = group.total === 1;
  const muted = theme.colors.foregroundMuted;

  return (
    <View style={[cardStyle(theme), { paddingVertical: 6 }]}>
      <PressableRow
        accessibilityLabel={`${group.playbookId}, ${groupSummary(group)}`}
        {...(single ? {} : { expanded: open })}
        onPress={() => {
          if (single) onOpen(group.latest.id);
          else setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}
      >
        <StatusGlyph theme={theme} glyph={group.latest.glyph} tone={group.latest.tone} />
        <Txt theme={theme} size={13} bold lines={1} style={{ flexShrink: 1 }}>
          {group.playbookId}
        </Txt>
        <Pill theme={theme} label={group.latest.statusLabel} tone={group.latest.tone} />
        <Txt theme={theme} color={muted} size={11} lines={1} style={{ flexShrink: 1 }}>
          {groupSummary(group)}
          {single
            ? ` · ${group.latest.triggerLabel} · ${group.latest.updatedRelative} · ${group.latest.durationLabel}`
            : ""}
        </Txt>
        <Txt theme={theme} color={muted} size={11} style={{ marginLeft: "auto" }}>
          {single ? "›" : open ? "▾" : "▸"}
        </Txt>
      </PressableRow>

      {!single && open
        ? shown.map((run) => <RunRow key={run.id} theme={theme} run={run} onOpen={onOpen} />)
        : null}
      {!single && open && hidden > 0 ? (
        <Button
          theme={theme}
          tone="accent"
          label={`Show ${Math.min(hidden, RUNS_PER_GROUP)} older`}
          style={{ alignSelf: "flex-start", marginTop: 6, marginBottom: 2 }}
          onPress={() => {
            setLimit(limit + RUNS_PER_GROUP);
          }}
        />
      ) : null}
    </View>
  );
}

export function RunList({
  theme,
  view,
  onOpen,
  onFilter,
}: {
  theme: PluginTheme;
  view: PanelView;
  onOpen: (runId: string) => void;
  onFilter: (filter: PanelView["filter"]) => void;
}) {
  const muted = theme.colors.foregroundMuted;
  return (
    <View>
      <Row wrap style={{ marginTop: 10 }}>
        {view.filters.map((filter) => {
          const active = filter.id === view.filter;
          return (
            <Button
              key={filter.id}
              theme={theme}
              tone={active ? "accent" : "neutral"}
              label={`${filter.label} ${filter.count}`}
              style={active ? { borderColor: toneColor(theme, "accent") } : null}
              onPress={() => {
                onFilter(filter.id);
              }}
            />
          );
        })}
      </Row>

      {view.empty ? (
        <Txt theme={theme} color={muted} size={12} style={{ marginTop: 12 }}>
          No Argos runs yet. Start one above, or ask an agent to use argos_start_playbook.
        </Txt>
      ) : null}

      {!view.empty && view.groups.length === 0 ? (
        <Txt theme={theme} color={muted} size={12} style={{ marginTop: 12 }}>
          No run matches this filter.
        </Txt>
      ) : null}

      {view.groups.map((group) => (
        <WorkflowGroup key={group.playbookId} theme={theme} group={group} onOpen={onOpen} />
      ))}
    </View>
  );
}
