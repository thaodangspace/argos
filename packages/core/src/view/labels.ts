/**
 * Status vocabulary for every Argos client (spec FR6).
 *
 * These labels, tones, and glyphs are the *only* place a run/step status becomes human text. The
 * web UI maps a tone onto Skeleton colour pairings, so a label and its colour cannot drift.
 */

import type { RunStatus, StepKind, StepStatus } from "../rpc/contracts.js";

/** Tone names a client maps onto its own palette (`success`, `danger`, …). */
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting for gate",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  waiting: "Waiting for gate",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export const STEP_KIND_LABELS: Readonly<Record<StepKind, string>> = {
  agent: "agent",
  gate: "gate",
  script: "script",
  branch: "branch",
  delay: "delay",
};

export function runStatusTone(status: RunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "waiting":
      return "warning";
    case "cancelled":
    case "pending":
      return "neutral";
  }
}

export function stepStatusTone(status: StepStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    case "waiting":
      return "warning";
    case "ready":
    case "skipped":
    case "pending":
      return "neutral";
  }
}

/** `pending` · `running` · `waiting` — the run statuses that still need a process. */
export function isActiveRun(status: RunStatus): boolean {
  return status === "running" || status === "waiting" || status === "pending";
}

/**
 * The list's status filter (GitHub CI's "Filter workflow runs"). `running` covers every run that
 * still needs a process (`pending`, `running`, `waiting`), which is what a user means by it.
 */
export type RunFilter = "all" | "running" | "failed" | "completed";

export const RUN_FILTERS: readonly RunFilter[] = ["all", "running", "failed", "completed"];

export const RUN_FILTER_LABELS: Readonly<Record<RunFilter, string>> = {
  all: "All",
  running: "Running",
  failed: "Failed",
  completed: "Completed",
};

/** True when a run belongs to the filter. `cancelled` counts as failed (it needs attention too). */
export function runMatchesFilter(status: RunStatus, filter: RunFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return isActiveRun(status);
    case "failed":
      return status === "failed" || status === "cancelled";
    case "completed":
      return status === "completed";
  }
}

/** A one-column glyph (`✓`, `✕`, `●`, …) so a row scans without relying on color. */
export const RUN_STATUS_GLYPHS: Readonly<Record<RunStatus, string>> = {
  pending: "○",
  running: "●",
  waiting: "◔",
  completed: "✓",
  failed: "✕",
  cancelled: "⊘",
};

export const STEP_STATUS_GLYPHS: Readonly<Record<StepStatus, string>> = {
  pending: "○",
  ready: "◌",
  running: "●",
  waiting: "◔",
  completed: "✓",
  failed: "✕",
  skipped: "–",
};
