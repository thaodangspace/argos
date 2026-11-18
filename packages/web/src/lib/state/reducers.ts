/**
 * Pure reducers for the live run list (spec FR11). Kept out of the runes store so the ordering and
 * de-duplication rules are testable without a Svelte runtime.
 */

import type { RunDetail, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";
import { sortRuns } from "@thaodangspace/argos-core/view";

/** A snapshot replaces the whole list (the server is the source of truth). */
export function replaceRuns(runs: readonly RunSummary[]): RunSummary[] {
  return sortRuns(runs);
}

/** One changed run: replace its entry or append it, then re-sort newest-first. */
export function mergeRun(runs: readonly RunSummary[], incoming: RunSummary): RunSummary[] {
  const next = runs.some((run) => run.id === incoming.id)
    ? runs.map((run) => (run.id === incoming.id ? incoming : run))
    : [...runs, incoming];
  return sortRuns(next);
}

/**
 * `seq` is the only reason to re-read a run's detail: an unchanged run must not cause a request on
 * every frame (spec FR11).
 */
export function shouldRefetchDetail(detail: RunDetail | null, seq: number): boolean {
  return detail === null || detail.seq !== seq;
}
