/**
 * The run-list model (GitHub-Actions-shaped): time is the primary axis and a workflow is a facet.
 *
 * `run-view.ts` renders one run; this module decides which runs the list shows, in what order, and
 * how the facets (project, workflow, trigger, executor) are offered. It is pure and DOM-free for the
 * same reason: both clients render the same list, and the tests pin every label.
 *
 * The two axes exist because a schedule fires the same playbook every hour *and* an Argos server
 * hosts many projects: grouping by playbook alone answers "which runs of this workflow" but loses
 * "which workflow ran before which", and it collapses two same-named playbooks from two checkouts
 * into one group. So the list is chronological by default, and a facet narrows it.
 */

import type { RunSummary } from "../rpc/contracts.js";
import { formatDate, pluralized } from "./format.js";
import { runMatchesFilter, type RunFilter } from "./labels.js";
import type { RunView } from "./run-view.js";

/** The list order. `start` is the timeline; `activity` keeps a live run pinned to the top. */
export type RunSort = "start" | "activity";

export const RUN_SORTS: readonly RunSort[] = ["start", "activity"];

export const RUN_SORT_LABELS: Readonly<Record<RunSort, string>> = {
  start: "Newest start",
  activity: "Recent activity",
};

/** How a run came to exist, as one facet value (`argos fork` and a schedule are not "manual"). */
export type RunTriggerFacet = "manual" | "schedule" | "fork";

/** Declared order, so the facet list never reshuffles as counts move. */
export const RUN_TRIGGERS: readonly RunTriggerFacet[] = ["manual", "schedule", "fork"];

export const RUN_TRIGGER_LABELS: Readonly<Record<RunTriggerFacet, string>> = {
  manual: "Manual",
  schedule: "Schedule",
  fork: "Fork",
};

/** The default substrate is omitted from a summary, so the facet uses the canonical id. */
export const DEFAULT_EXECUTOR = "paseo";

/** What the list shows. Every key except `status` is an optional facet. */
export interface RunListQuery {
  readonly status: RunFilter;
  readonly project?: string;
  readonly workflow?: string;
  readonly trigger?: RunTriggerFacet;
  readonly executor?: string;
}

/** One selectable facet value with its inventory count (counted over every run, not the filter). */
export interface FacetOption {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /** Runs of this value that still need a process — the rail draws a dot for it. */
  readonly active: number;
  readonly failed: number;
  /**
   * The entry is still in use: it has a live run **or** an enabled schedule fires it. The rail uses
   * this to keep the idle half of the inventory collapsed, so a dead one-off never crowds the eye.
   */
  readonly live: boolean;
}

export interface RunFacets {
  readonly workflows: readonly FacetOption[];
  readonly projects: readonly FacetOption[];
  readonly triggers: readonly FacetOption[];
  readonly executors: readonly FacetOption[];
}

/** Consecutive runs of one local day, so a long list reads as a timeline. */
export interface DaySectionView {
  readonly day: string;
  readonly label: string;
  readonly runs: readonly RunView[];
}

/**
 * The project a run belongs to: the last segment of its `cwd`. Two checkouts of the same repository
 * name under different parents therefore share a project label, which is what an operator means by
 * "the vsee runs"; the full path stays on the run page.
 */
export function projectOf(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  if (trimmed === "") return cwd;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

export function runTriggerFacet(run: RunSummary): RunTriggerFacet {
  if (run.forkedFrom !== undefined) return "fork";
  return run.trigger === undefined ? "manual" : "schedule";
}

/** `createdAt` desc — the timeline order ("which workflow ran before which"). */
export function compareByStart(left: RunView, right: RunView): number {
  return right.createdAt - left.createdAt || tiebreak(left, right);
}

/** `updatedAt` desc — the activity order (a live run stays where the eye expects it). */
export function compareByActivity(left: RunView, right: RunView): number {
  return right.updatedAt - left.updatedAt || tiebreak(left, right);
}

function tiebreak(left: RunView, right: RunView): number {
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

export function sortRunViews(runs: readonly RunView[], sort: RunSort = "start"): RunView[] {
  return [...runs].sort(sort === "start" ? compareByStart : compareByActivity);
}

/** True when the run belongs to every facet of `query` (an absent facet matches everything). */
export function runMatchesQuery(run: RunView, query: RunListQuery): boolean {
  if (!runMatchesFilter(run.status, query.status)) return false;
  if (query.workflow !== undefined && run.playbookId !== query.workflow) return false;
  if (query.project !== undefined && run.project !== query.project) return false;
  if (query.trigger !== undefined && run.triggerFacet !== query.trigger) return false;
  if (query.executor !== undefined && (run.executor ?? DEFAULT_EXECUTOR) !== query.executor) {
    return false;
  }
  return true;
}

export function filterRunViews(
  runs: readonly RunView[],
  query: RunListQuery,
): RunView[] {
  return runs.filter((run) => runMatchesQuery(run, query));
}

/**
 * Facet inventories over every run, so a facet shows its own total rather than the filter's.
 *
 * `liveWorkflows` is the playbook id of every **enabled schedule**: a scheduled workflow is in use
 * even while it sleeps. A facet is `live` when any of its runs is active or its workflow is listed,
 * which is what separates the rail's "in use" half from the idle one.
 */
export function runFacets(
  runs: readonly RunView[],
  options: { readonly liveWorkflows?: readonly string[] } = {},
): RunFacets {
  const scheduled = new Set(options.liveWorkflows ?? []);
  const inUse = (run: RunView): boolean => run.active || scheduled.has(run.playbookId);
  const collect = (
    value: (run: RunView) => string | undefined,
    order?: readonly string[],
    isLive: (run: RunView) => boolean = (run) => run.active,
  ): FacetOption[] => {
    const seen = new Map<string, { count: number; active: number; failed: number; live: boolean }>();
    for (const run of runs) {
      const id = value(run);
      if (id === undefined) continue;
      const entry = seen.get(id) ?? { count: 0, active: 0, failed: 0, live: false };
      entry.count += 1;
      if (run.active) entry.active += 1;
      if (run.status === "failed" || run.status === "cancelled") entry.failed += 1;
      if (isLive(run)) entry.live = true;
      seen.set(id, entry);
    }
    const entries = [...seen].map(([id, entry]) => ({ id, label: id, ...entry }));
    if (order !== undefined) {
      return entries.sort((left, right) => rank(order, left.id) - rank(order, right.id));
    }
    return entries.sort((left, right) => right.count - left.count || byId(left, right));
  };
  const executors = collect(
    (run) => run.executor ?? DEFAULT_EXECUTOR,
    [...new Set([DEFAULT_EXECUTOR, ...runs.map((run) => run.executor ?? DEFAULT_EXECUTOR)])],
  );
  return {
    workflows: collect((run) => run.playbookId, undefined, inUse),
    // A project is in use when one of its runs belongs to a workflow that is.
    projects: collect((run) => run.project, undefined, inUse),
    triggers: collect((run) => run.triggerFacet, RUN_TRIGGERS),
    executors,
  };
}

function rank(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? order.length : index;
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * `YYYY-MM-DD` in **the reader's zone**, so a section header never disagrees with the `3h ago` label
 * on the rows it holds (a UTC day would, for any viewer east or west of Greenwich).
 */
export function dayKey(at: number, timeZone?: string): string {
  return formatDate(at, timeZone);
}

/** The calendar day before `at`, as a key: arithmetic on the date itself, never on 86 400 000 ms. */
function previousDayKey(at: number, timeZone?: string): string {
  const [year, month, day] = dayKey(at, timeZone).split("-").map(Number);
  const previous = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1));
  return previous.toISOString().slice(0, 10);
}

export function dayLabel(day: string, now: number, timeZone?: string): string {
  if (day === dayKey(now, timeZone)) return "Today";
  if (day === previousDayKey(now, timeZone)) return "Yesterday";
  return day;
}

/** Split an already-ordered list into consecutive day sections (`Today`, `Yesterday`, …). */
export function daySections(
  runs: readonly RunView[],
  now: number,
  timeZone?: string,
): DaySectionView[] {
  const sections: DaySectionView[] = [];
  let current: { day: string; label: string; runs: RunView[] } | undefined;
  for (const run of runs) {
    const day = dayKey(run.createdAt, timeZone);
    if (current === undefined || current.day !== day) {
      current = { day, label: dayLabel(day, now, timeZone), runs: [] };
      sections.push(current);
    }
    current.runs.push(run);
  }
  return sections;
}

/**
 * One unlabeled section: the activity order interleaves days, so a day header would lie. The list
 * renders no heading for an empty label.
 */
export function unsectioned(runs: readonly RunView[]): DaySectionView[] {
  return runs.length === 0 ? [] : [{ day: "", label: "", runs }];
}

/** The list's title: the narrowest selected scope, mirroring GitHub's workflow page heading. */
export const ALL_RUNS_TITLE = "All workflows";

export function scopeTitle(query: RunListQuery): string {
  return query.workflow ?? query.project ?? ALL_RUNS_TITLE;
}

/** The one-line explanation under the title (GitHub: "Showing runs from all workflows"). */
export function scopeSubtitle(query: RunListQuery, visible: number): string {
  const count = pluralized(visible, "run");
  if (query.workflow !== undefined && query.project !== undefined) {
    return `${count} · ${query.workflow} in ${query.project}`;
  }
  if (query.workflow !== undefined) return `${count} · workflow ${query.workflow}`;
  if (query.project !== undefined) return `${count} · project ${query.project}`;
  return `${count} · all workflows, newest start first`;
}
