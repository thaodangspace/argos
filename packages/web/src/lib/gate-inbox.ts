/**
 * The gate inbox projection (inbox FR2): every pending gate of the given runs, oldest first, each
 * joined to the run context a card needs (playbook, project, trigger, executor, step).
 *
 * Web-local on purpose: the shared view model (`@thaodangspace/argos-core/view`) has no run join for
 * a gate and no day-granularity age, and a formatter only this page uses must not grow that package.
 * Pure — no Svelte, no DOM, no I/O, no clock read (`now` is injected), so the order and every label
 * are pinned by a Node test.
 */

import type { RunStatus, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";
import {
  DEFAULT_EXECUTOR,
  formatDateTime,
  gateKey,
  gateView,
  projectOf,
  runTriggerFacet,
  type GateView,
  type RunTriggerFacet,
} from "@thaodangspace/argos-core/view";

/** The run context of one pending gate; the card's header renders it. */
export interface GateInboxRun {
  readonly id: string;
  readonly playbookId: string;
  readonly project: string;
  readonly status: RunStatus;
  readonly triggerFacet: RunTriggerFacet;
  /** The canonical substrate id; `paseo` is omitted from a summary, never from here. */
  readonly executor: string;
  readonly stepId: string;
}

/** One pending gate plus the run it belongs to and its (clamped) age. */
export interface GateInboxEntry {
  /** `<runId>.<gateId>` — unique across runs, so two `fix:1` gates stay distinct. */
  readonly key: string;
  /** The shared gate view; `deciding` is set for a key in the options bag. */
  readonly gate: GateView;
  readonly run: GateInboxRun;
  /** `GateSummary.createdAt` when the server projects it, else `RunSummary.updatedAt` (inbox FR1). */
  readonly waitingSince: number;
  /** `now - waitingSince`, clamped at `0` so a backward clock never prints a negative age (FR8). */
  readonly ageMs: number;
  /** Zone-free relative age: `3d 4h`, `3h 12m`, `2m`, `45s`. */
  readonly ageLabel: string;
  /** The absolute open time in the reader's zone (`formatDateTime`). */
  readonly sinceLabel: string;
}

export interface GateInboxOptions {
  /** The render instant; injected so the projection reads no clock. */
  readonly now: number;
  /** The reader's IANA zone; `undefined` is the runtime's own (inbox FR8). */
  readonly timeZone: string | undefined;
  /** Gate keys (`<runId>.<gateId>`) with a decision in flight, so the card disables its buttons. */
  readonly deciding?: readonly string[] | undefined;
}

const SECOND = 1_000;

/**
 * A gate's age for a human: at most two units, and days where `formatDuration` stops at hours
 * (`3d 4h`, `3h 12m`, `2m`, `45s`). The shape below an hour is `formatDuration`'s; a negative or
 * non-finite gap is clamped to `0` before formatting (inbox FR8), so it prints `0s`, never `-3m`.
 */
export function formatAge(ms: number): string {
  const gap = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.round(gap / SECOND);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function ageOf(waitingSince: number, now: number): number {
  const gap = now - waitingSince;
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/** Oldest first, then `runId`, then `gateId` — the order is total, so a re-render never reshuffles. */
function compareEntries(left: GateInboxEntry, right: GateInboxEntry): number {
  const byWaiting = left.waitingSince - right.waitingSince;
  // A non-finite instant (`NaN`) compares as "equal" and falls through to the ids.
  if (Number.isFinite(byWaiting) && byWaiting !== 0) return byWaiting;
  if (left.run.id !== right.run.id) return left.run.id < right.run.id ? -1 : 1;
  if (left.gate.gateId === right.gate.gateId) return 0;
  return left.gate.gateId < right.gate.gateId ? -1 : 1;
}

/**
 * Every pending gate of `runs`, oldest first. The hidden-workflow preference is deliberately not an
 * input (inbox FR9): the rail hides list rows, never work that waits for a person.
 *
 * `pendingGates()` is not used here on purpose — it flattens the gates and loses the run join.
 */
export function gateInbox(
  runs: readonly RunSummary[],
  options: GateInboxOptions,
): GateInboxEntry[] {
  const deciding = options.deciding ?? [];
  const entries: GateInboxEntry[] = [];
  for (const run of runs) {
    for (const gate of run.gates) {
      if (gate.status !== "pending") continue;
      const key = gateKey(run.id, gate.gateId);
      const waitingSince = gate.createdAt ?? run.updatedAt;
      const ageMs = ageOf(waitingSince, options.now);
      entries.push({
        key,
        gate: gateView(gate, { deciding: deciding.includes(key) }),
        run: {
          id: run.id,
          playbookId: run.playbookId,
          project: projectOf(run.cwd),
          status: run.status,
          triggerFacet: runTriggerFacet(run),
          executor: run.executor ?? DEFAULT_EXECUTOR,
          stepId: gate.stepId,
        },
        waitingSince,
        ageMs,
        ageLabel: formatAge(ageMs),
        // `Intl` throws on a non-finite instant, so an unformattable open time is left blank (the
        // same convention as `formatClock` for a missing timestamp).
        sinceLabel: Number.isFinite(waitingSince)
          ? formatDateTime(waitingSince, options.timeZone)
          : "",
      });
    }
  }
  entries.sort(compareEntries);
  return entries;
}
