/**
 * The CI-style run list: filter chips, then one collapsible group per playbook.
 *
 * A schedule fires the same playbook every hour, so the list groups by workflow instead of
 * printing a wall of identical cards; only the newest runs of a group are shown until asked.
 */

import { useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";

import type { PanelView, RunView, WorkflowGroupView } from "../shared/panel";
import { buttonStyle, Pill, RunId, StatusGlyph, StepProgress, toneColor } from "./ui";

const RUNS_PER_GROUP = 5;

function rowStyle(theme: PluginTheme) {
  return {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
    width: "100%",
    textAlign: "left" as const,
    background: "transparent",
    color: theme.colors.foreground,
    border: "none",
    borderTop: `1px solid ${theme.colors.border}`,
    padding: "7px 0",
    cursor: "pointer",
    font: "inherit",
  };
}

function RunRow({
  theme,
  run,
  onOpen,
}: {
  theme: PluginTheme;
  run: RunView;
  onOpen: (runId: string) => void;
}) {
  return (
    <button type="button" onClick={() => onOpen(run.id)} style={rowStyle(theme)}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <StatusGlyph theme={theme} glyph={run.glyph} tone={run.tone} />
        <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.playbookId}
        </span>
        <RunId theme={theme} id={run.runIdShort} />
        <Pill theme={theme} label={run.statusLabel} tone={run.tone} />
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: theme.colors.foregroundMuted,
            whiteSpace: "nowrap",
          }}
        >
          {run.durationLabel}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: theme.colors.foregroundMuted }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.triggerLabel} · {run.updatedRelative} · {run.detail}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          <StepProgress theme={theme} segments={run.progress} />
          <span style={{ whiteSpace: "nowrap" }}>
            {run.completedCount}/{run.stepCount}
          </span>
        </span>
      </span>
    </button>
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

  return (
    <div
      style={{
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface1,
        borderRadius: 8,
        padding: "6px 10px",
        marginTop: 8,
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (single) onOpen(group.latest.id);
          else setOpen(!open);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          color: theme.colors.foreground,
          border: "none",
          padding: "2px 0",
          cursor: "pointer",
          font: "inherit",
        }}
      >
        <StatusGlyph theme={theme} glyph={group.latest.glyph} tone={group.latest.tone} />
        <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {group.playbookId}
        </strong>
        <Pill theme={theme} label={group.latest.statusLabel} tone={group.latest.tone} />
        <span
          style={{
            fontSize: 11,
            color: theme.colors.foregroundMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {groupSummary(group)}
          {single
            ? ` · ${group.latest.triggerLabel} · ${group.latest.updatedRelative} · ${group.latest.durationLabel}`
            : ""}
        </span>
        <span style={{ marginLeft: "auto", color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {single ? "›" : open ? "▾" : "▸"}
        </span>
      </button>

      {!single && open
        ? shown.map((run) => <RunRow key={run.id} theme={theme} run={run} onOpen={onOpen} />)
        : null}
      {!single && open && hidden > 0 ? (
        <button
          type="button"
          onClick={() => {
            setLimit(limit + RUNS_PER_GROUP);
          }}
          style={{
            ...buttonStyle(theme, "accent"),
            marginTop: 6,
            marginBottom: 2,
          }}
        >
          Show {Math.min(hidden, RUNS_PER_GROUP)} older
        </button>
      ) : null}
    </div>
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
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {view.filters.map((filter) => {
          const active = filter.id === view.filter;
          return (
            <button
              key={filter.id}
              type="button"
              onClick={() => {
                onFilter(filter.id);
              }}
              style={{
                ...buttonStyle(theme, active ? "accent" : "neutral"),
                ...(active ? { border: `1px solid ${toneColor(theme, "accent")}` } : {}),
              }}
            >
              {filter.label} {filter.count}
            </button>
          );
        })}
      </div>

      {view.empty ? (
        <div style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 12 }}>
          No Argos runs yet. Start one above, or ask an agent to use argos_start_playbook.
        </div>
      ) : null}

      {!view.empty && view.groups.length === 0 ? (
        <div style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 12 }}>
          No run matches this filter.
        </div>
      ) : null}

      {view.groups.map((group) => (
        <WorkflowGroup key={group.playbookId} theme={theme} group={group} onOpen={onOpen} />
      ))}
    </div>
  );
}
