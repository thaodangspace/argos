/**
 * The step log, built only from the `RunDetail` projection (spec FR6, FR10).
 *
 * Agent transcripts are never stored by Argos, so a step's log is its history events, its attempts
 * (target, duration, usage, outcome, the reason line, and the bounded stdout/stderr tails), its
 * **declared** outputs, its outcome/error, and the gates opened for it. One implementation serves
 * the web UI and the CLI's read model so adding a history event stays a two-edit change (the event
 * list and this switch).
 */

import type {
  GateSummary,
  HistoryEvent,
  StepDetailSummary,
  StepSummary,
} from "../rpc/contracts.js";
import {
  formatClock,
  formatCostUsd,
  formatDuration,
  formatScalar,
  formatTokens,
  formatUsage,
} from "./format.js";
import type { StatusTone } from "./labels.js";

/** One launch attempt as the step log renders it. */
export interface StepAttemptView {
  readonly n: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationLabel: string;
  readonly target?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  /** The attempt's own reason line (`the script exited 1: …`), already normalized and bounded. */
  readonly detail?: string;
  /** The attempt's last exit code, when the executor reported one (a script step). */
  readonly exitCode?: number;
  /**
   * The attempt's own program output, each side a bounded tail with the marker `… (truncated)`
   * first when it was cut. Never an agent prompt, a transcript, or an hc terminal text.
   */
  readonly streams?: StepDetailSummary["attempts"][number]["streams"];
  readonly usageLabel: string | null;
  readonly running: boolean;
}

/** One declared output of a step (a script's `stdout`, an agent's schema output). */
export interface StepOutputView {
  readonly name: string;
  readonly value: string;
  /** `value` split on newlines: the log pane prints one line per entry. */
  readonly lines: readonly string[];
}

/** One line of the step log (or of the run log). */
export interface StepLogEntry {
  readonly at: number | null;
  readonly timeLabel: string;
  readonly text: string;
  readonly tone: StatusTone;
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  completed: "completed",
  failed: "failed",
  timeout: "timed out",
  cancelled: "cancelled",
};

function historyTone(type: HistoryEvent["type"]): StatusTone {
  switch (type) {
    case "task_error":
      return "danger";
    case "gate":
      return "warning";
    case "gate_decided":
      return "success";
    case "dispatch":
    case "retry":
    case "script_repinned":
    case "forked_from":
      return "accent";
    case "finish":
    case "after_start":
    case "run_started":
    case "settle":
    case "after_queued":
    case "effect_skipped":
    case "select":
      return "success";
    default:
      return "neutral";
  }
}

/** One history event as a log line. The vocabulary is fixed, so a new type must be added here. */
export function historyText(event: HistoryEvent): string {
  const detail = event.detail ?? "";
  const suffix = detail === "" ? "" : `: ${detail}`;
  switch (event.type) {
    case "run_started":
      return `Run started${suffix}`;
    case "select":
      return "Selecting ready steps";
    case "dispatch":
      return `Dispatched${event.attempt === null ? "" : ` (attempt ${event.attempt})`}`;
    case "settle":
      return `Settled${suffix}`;
    case "gate":
      return `Gate opened${suffix}`;
    case "gate_decided":
      return `Gate decided${suffix}`;
    case "finish":
      return `Run finished${suffix}`;
    case "effect_skipped":
      return `Effect skipped${suffix}`;
    case "task_error":
      return `Task error${suffix}`;
    case "after_queued":
      return `After-task queued${suffix}`;
    case "after_start":
      return `After-task started${suffix}`;
    case "retry":
      return `Retried${suffix}`;
    case "script_repinned":
      return `Script repinned${suffix}`;
    case "forked_from":
      return `Forked${suffix}`;
  }
}

interface PendingLogEntry {
  readonly at: number | null;
  readonly sortAt: number;
  readonly text: string;
  readonly tone: StatusTone;
}

function pendingEntry(
  at: number | null,
  text: string,
  tone: StatusTone,
  offset = 0,
): PendingLogEntry {
  return { at, sortAt: (at ?? Number.MAX_SAFE_INTEGER) + offset, text, tone };
}

/** A line that belongs to the entry before it (an output's second line): no timestamp of its own. */
function continuationEntry(base: number | null, text: string, tone: StatusTone): PendingLogEntry {
  return {
    at: null,
    sortAt: (base ?? Number.MAX_SAFE_INTEGER) + 0.5,
    text,
    tone,
  };
}

/**
 * A stream tail's line: no timestamp of its own, and it sits **immediately** after the label that
 * introduced it (`stdout:`), so a tail never drifts below a later attempt's lines. It shares the
 * label's instant and is ordered by insertion (the sort's index tie-break).
 */
function tailEntry(sortAt: number, text: string, tone: StatusTone): PendingLogEntry {
  return { at: null, sortAt, text, tone };
}

function historyEntry(event: HistoryEvent): PendingLogEntry {
  return pendingEntry(event.at, historyText(event), historyTone(event.type));
}

/** Log entries carry a display time; a continuation line (an output's second line) has none. */
function toLogEntries(
  entries: readonly PendingLogEntry[],
  timeZone: string | undefined,
): StepLogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.sortAt - right.entry.sortAt || left.index - right.index)
    .map(({ entry }) => ({
      at: entry.at,
      timeLabel: formatClock(entry.at, timeZone),
      text: entry.text,
      tone: entry.tone,
    }));
}

export function attemptViews(
  attempts: readonly StepDetailSummary["attempts"][number][],
): StepAttemptView[] {
  return attempts.map((attempt) => {
    const ended = attempt.endedAt;
    return {
      n: attempt.n,
      startedAt: attempt.startedAt,
      ...(ended === undefined ? {} : { endedAt: ended }),
      durationLabel: ended === undefined ? "running" : formatDuration(ended - attempt.startedAt),
      ...(attempt.target === undefined ? {} : { target: attempt.target }),
      ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
      ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
      ...(attempt.exitCode === undefined ? {} : { exitCode: attempt.exitCode }),
      ...(attempt.streams === undefined ? {} : { streams: attempt.streams }),
      usageLabel: formatUsage(attempt.usage),
      running: ended === undefined,
    };
  });
}

export function outputViews(outputs: StepDetailSummary["outputs"]): StepOutputView[] {
  if (outputs === undefined) return [];
  return Object.entries(outputs).map(([name, value]) => {
    const text = formatScalar(value);
    return { name, value: text, lines: text.replace(/\n$/, "").split("\n") };
  });
}

/**
 * The step's log, built from the detail projection alone: its history events, its attempts (with
 * target, usage, the reason line, and the stream tails), its declared outputs, its outcome/error,
 * and the gates opened for it. `timeZone` is the reader's zone (`undefined` = this runtime's),
 * applied to every line's timestamp.
 */
export function buildStepLog(input: {
  readonly step: StepSummary;
  readonly history: readonly HistoryEvent[];
  readonly gates: readonly GateSummary[];
  readonly attempts: readonly StepAttemptView[];
  readonly outputs: readonly StepOutputView[];
  readonly outcome?: string;
  readonly timeZone?: string | undefined;
}): StepLogEntry[] {
  const entries: PendingLogEntry[] = [];
  for (const event of input.history) {
    if (event.stepId !== input.step.id) continue;
    if (event.type === "select") continue;
    entries.push(historyEntry(event));
  }

  const lastEnded = input.step.endedAt ?? input.step.startedAt ?? null;
  for (const attempt of input.attempts) {
    entries.push(
      pendingEntry(
        attempt.startedAt,
        `Attempt ${attempt.n} started${attempt.target === undefined ? "" : ` on ${attempt.target}`}`,
        "accent",
      ),
    );
    if (attempt.endedAt !== undefined) {
      const word =
        attempt.outcome === undefined
          ? "finished"
          : (OUTCOME_WORDS[attempt.outcome] ?? attempt.outcome);
      const code = attempt.errorCode === undefined ? "" : ` (${attempt.errorCode})`;
      const reason = attempt.detail === undefined ? "" : `: ${attempt.detail}`;
      const failed =
        attempt.outcome === "failed" ||
        attempt.outcome === "timeout" ||
        attempt.outcome === "cancelled";
      entries.push(
        pendingEntry(
          attempt.endedAt,
          `Attempt ${attempt.n} ${word} in ${attempt.durationLabel}${code}${reason}`,
          failed ? "danger" : "success",
        ),
      );
    }
    const tailAt = attempt.endedAt ?? attempt.startedAt;
    if (attempt.usageLabel !== null) {
      entries.push(pendingEntry(tailAt, `Usage: ${attempt.usageLabel}`, "neutral"));
    }
    for (const side of ["stdout", "stderr"] as const) {
      const value = attempt.streams?.[side];
      if (value === undefined || value === "") continue;
      entries.push(pendingEntry(tailAt, `${side}:`, "neutral"));
      for (const line of value.replace(/\n$/, "").split("\n")) {
        entries.push(tailEntry(tailAt, line, "neutral"));
      }
    }
  }

  for (const output of input.outputs) {
    entries.push(pendingEntry(lastEnded, `Output ${output.name}:`, "neutral"));
    for (const line of output.lines) entries.push(continuationEntry(lastEnded, line, "neutral"));
  }

  if (input.outcome !== undefined) {
    entries.push(pendingEntry(lastEnded, `Outcome: ${input.outcome}`, "neutral", 0.5));
  }
  if (input.step.errorCode !== undefined) {
    entries.push(pendingEntry(lastEnded, `Error: ${input.step.errorCode}`, "danger", 0.5));
  }

  for (const gate of input.gates) {
    if (gate.stepId !== input.step.id) continue;
    const decided = gate.status === "decided";
    entries.push(
      pendingEntry(
        decided ? (gate.decidedAt ?? null) : lastEnded,
        `Gate ${gate.gateId} (${gate.kind}) ${gate.status}${gate.question === "" ? "" : `: ${gate.question}`}`,
        decided ? "success" : "warning",
      ),
    );
    if (gate.decision !== undefined) {
      const by = gate.decidedBy === undefined ? "" : ` by ${gate.decidedBy}`;
      const via = gate.decidedVia === undefined ? "" : ` via ${gate.decidedVia}`;
      entries.push(
        pendingEntry(gate.decidedAt ?? lastEnded, `Decision: ${gate.decision}${by}${via}`, "success"),
      );
    }
    if (gate.comment !== undefined && gate.comment !== "") {
      entries.push(pendingEntry(null, `Comment: ${gate.comment}`, "neutral"));
    }
  }

  return toLogEntries(entries, input.timeZone);
}

/** `01:49:00  Attempt 1 started on claude/opus` — the copyable text of a log. */
export function logText(entries: readonly StepLogEntry[]): string {
  return entries
    .map((entry) =>
      entry.at === null ? `        ${entry.text}` : `${entry.timeLabel}  ${entry.text}`,
    )
    .join("\n");
}

/**
 * Compact accounting for a row: the reported cost when there is one, else the token counters (a
 * provider that reports tokens but no price still shows something). `null` when nothing was
 * reported, so a step without an agent (script, gate, delay) adds no noise.
 */
export function compactUsage(usage: Readonly<Record<string, number>> | undefined): string | null {
  if (usage === undefined) return null;
  const cost = usage["totalCostUsd"];
  if (cost !== undefined) return formatCostUsd(cost);
  const input = usage["inputTokens"];
  const output = usage["outputTokens"];
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${formatTokens(input)} in`);
  if (output !== undefined) parts.push(`${formatTokens(output)} out`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Run-level lines: everything that is not tied to one step. */
export function buildRunLog(
  history: readonly HistoryEvent[],
  options: { readonly timeZone?: string | undefined } = {},
): StepLogEntry[] {
  return toLogEntries(
    history
      .filter((event) => event.stepId === null && event.type !== "select")
      .map((event) => historyEntry(event)),
    options.timeZone,
  );
}
