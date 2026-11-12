/**
 * FR4 worktree cleanup — the host-side half of `argos worktree rm` / `argos worktree gc`.
 *
 * Two rules shape everything here:
 *
 * 1. **Record-only paths (FR4.4).** A path or branch is never taken from a request. The run record
 *    names `{path, branch}`, and {@link recordRunWorktree} refuses anything that is not exactly
 *    `<home>/worktrees/<runId>` on `argos/<runId>` — so a hand-edited record cannot make the
 *    server delete an arbitrary directory.
 * 2. **Never automatic.** Nothing in the engine removes a worktree. gc is an operator command with
 *    an explicit age window; it skips a run that is not terminal (`active`), reports per-run
 *    outcomes, and only *reports* directories under `<home>/worktrees` that no run index entry
 *    claims (`orphans`), because deleting what Argos cannot account for is not its job.
 *
 * The git work itself lives in `src/git/worktree.ts`; this module decides what to hand it.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { ArgosError, isArgosError } from "../errors.js";
import { isTerminalRunStatus, type RunRecord, type WorktreeRecord } from "../engine/index.js";
import type { GitRunner } from "../git/exec.js";
import {
  removeRunWorktree,
  runWorktreeBranch,
  runWorktreePath,
  WORKTREES_DIR_NAME,
} from "../git/worktree.js";

/** A run mirror reduced to what cleanup needs (`ArgosHost.listRuns()` supplies `record`). */
export interface WorktreeRun {
  readonly runId: string;
  readonly record: RunRecord;
}

export interface RemoveWorktreeOptions {
  /** Remove a dirty worktree (FR4.2). Default `false`: refuse with `worktree_failed`. */
  readonly force?: boolean;
  /** Delete `argos/<runId>` too (FR4.3). Default `false`: keep the branch. */
  readonly deleteBranch?: boolean;
}

/** `argos worktree gc` / `POST /worktrees/gc` options (FR4.5). */
export interface GcWorktreesOptions extends RemoveWorktreeOptions {
  /** Only runs whose `updatedAt` is older than `now - olderThanMs`. */
  readonly olderThanMs: number;
  /** Report what would be removed without touching anything. */
  readonly dryRun?: boolean;
}

/** `POST /runs/:id/worktree/remove` (FR4.1). `path` is `""` for a run that has no worktree. */
export interface WorktreeRemovalResult {
  readonly runId: string;
  readonly path: string;
  readonly removed: boolean;
  readonly branchDeleted: boolean;
}

/** One worktree gc removed (or, with `dryRun`, would remove). */
export interface GcRemovedWorktree {
  readonly runId: string;
  readonly path: string;
  readonly branchDeleted: boolean;
}

/** A run gc looked at and left alone, with the reason (`active`, `path_mismatch`, a code). */
export interface GcSkippedWorktree {
  readonly runId: string;
  readonly reason: string;
}

/** `POST /worktrees/gc` (FR4.5). `orphans` are reported, never deleted. */
export interface GcWorktreesResult {
  readonly removed: readonly GcRemovedWorktree[];
  readonly skipped: readonly GcSkippedWorktree[];
  readonly orphans: readonly string[];
}

export interface RemoveWorktreeForRunInput extends RemoveWorktreeOptions {
  readonly runId: string;
  /** The mirrored record, or `undefined` for an unknown run. */
  readonly record: RunRecord | undefined;
  /** `$ARGOS_HOME`; `undefined` when the host owns none. */
  readonly home: string | undefined;
  readonly git?: GitRunner;
}

export interface GcWorktreesInput extends GcWorktreesOptions {
  readonly home: string;
  readonly runs: readonly WorktreeRun[];
  /** `ArgosHost.clock.now()`. */
  readonly now: number;
  readonly git?: GitRunner;
}

/**
 * The worktree the record names, checked against the only layout Argos creates (FR4.4). A mismatch
 * is `worktree_failed`: Argos removes and re-attaches its own checkouts only.
 */
export function recordRunWorktree(runId: string, record: RunRecord, home: string): WorktreeRecord {
  const worktree = record.worktree;
  if (worktree === undefined) {
    throw new ArgosError("worktree_failed", `run ${runId} has no worktree`);
  }
  const expectedPath = runWorktreePath(home, runId);
  const expectedBranch = runWorktreeBranch(runId);
  if (worktree.path !== expectedPath || worktree.branch !== expectedBranch) {
    throw new ArgosError(
      "worktree_failed",
      `run ${runId}: the record names worktree ${worktree.path} on ${worktree.branch}, not ${expectedPath} on ${expectedBranch}; Argos only cleans up worktrees it created`,
    );
  }
  return worktree;
}

/**
 * Remove one run's worktree (FR4.1–FR4.4): `run_unknown` for an absent record, `run_active` for a
 * run that has not finished, `removed: false` for a run that never had a worktree.
 */
export async function removeWorktreeForRun(
  input: RemoveWorktreeForRunInput,
): Promise<WorktreeRemovalResult> {
  const { runId, record } = input;
  if (record === undefined) {
    throw new ArgosError("run_unknown", `unknown run "${runId}"`);
  }
  if (!isTerminalRunStatus(record.status)) {
    throw new ArgosError(
      "run_active",
      `run ${runId} is ${record.status}; cancel it (or let it finish) before removing its worktree`,
    );
  }
  if (record.worktree === undefined) {
    return { runId, path: "", removed: false, branchDeleted: false };
  }
  if (input.home === undefined) {
    throw new ArgosError(
      "worktree_failed",
      `run ${runId}: removing a worktree needs an ARGOS_HOME for <home>/worktrees/<runId>`,
    );
  }
  const worktree = recordRunWorktree(runId, record, input.home);
  const outcome = await removeRunWorktree({
    repo: record.cwd,
    home: input.home,
    runId,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.deleteBranch === undefined ? {} : { deleteBranch: input.deleteBranch }),
    ...(input.git === undefined ? {} : { git: input.git }),
  });
  return {
    runId,
    path: worktree.path,
    removed: outcome.removed,
    branchDeleted: outcome.branchDeleted,
  };
}

/**
 * Which runs gc may remove, and which it must skip (FR4.5). A run is considered when it has a
 * worktree and `updatedAt < now - olderThan`; it is then skipped as `active` when it is not
 * terminal (the mirror is the source of truth, so a run that finishes during gc is still safe) and
 * as `path_mismatch` when its record does not name the layout Argos creates.
 */
export function selectWorktreesForGc(input: {
  readonly home: string;
  readonly runs: readonly WorktreeRun[];
  readonly now: number;
  readonly olderThanMs: number;
}): {
  readonly candidates: readonly WorktreeRun[];
  readonly skipped: readonly GcSkippedWorktree[];
} {
  const cutoff = input.now - input.olderThanMs;
  const candidates: WorktreeRun[] = [];
  const skipped: GcSkippedWorktree[] = [];
  for (const run of input.runs) {
    const worktree = run.record.worktree;
    if (worktree === undefined) continue;
    if (run.record.updatedAt >= cutoff) continue;
    if (!isTerminalRunStatus(run.record.status)) {
      skipped.push({ runId: run.runId, reason: "active" });
      continue;
    }
    if (
      worktree.path !== runWorktreePath(input.home, run.runId) ||
      worktree.branch !== runWorktreeBranch(run.runId)
    ) {
      skipped.push({ runId: run.runId, reason: "path_mismatch" });
      continue;
    }
    candidates.push(run);
  }
  return { candidates, skipped };
}

/**
 * The entries of `<home>/worktrees` that no run in the index claims (FR4.5). Reported only: a
 * directory Argos cannot account for is inspected by the operator, not deleted by gc.
 */
export function orphanWorktreeDirs(
  home: string,
  knownRunIds: ReadonlySet<string>,
): readonly string[] {
  const root = join(home, WORKTREES_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    // No directory yet (or unreadable): nothing to report.
    return [];
  }
  return names
    .filter((name) => !knownRunIds.has(name))
    .map((name) => join(root, name))
    .sort();
}

/**
 * Remove every worktree gc selected (FR4.5) and report what happened. A per-run failure becomes a
 * `skipped` entry with the `ArgosError` code as the reason, so one dirty or unmerged worktree never
 * aborts the sweep. With `dryRun` nothing is touched: `removed` lists what would go.
 */
export async function gcRunWorktrees(input: GcWorktreesInput): Promise<GcWorktreesResult> {
  const selection = selectWorktreesForGc({
    home: input.home,
    runs: input.runs,
    now: input.now,
    olderThanMs: input.olderThanMs,
  });
  const removed: GcRemovedWorktree[] = [];
  const skipped: GcSkippedWorktree[] = [...selection.skipped];
  for (const run of selection.candidates) {
    const path = run.record.worktree?.path ?? runWorktreePath(input.home, run.runId);
    if (input.dryRun === true) {
      removed.push({ runId: run.runId, path, branchDeleted: false });
      continue;
    }
    try {
      const outcome = await removeWorktreeForRun({
        runId: run.runId,
        record: run.record,
        home: input.home,
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.deleteBranch === undefined ? {} : { deleteBranch: input.deleteBranch }),
        ...(input.git === undefined ? {} : { git: input.git }),
      });
      removed.push({
        runId: run.runId,
        path: outcome.path,
        branchDeleted: outcome.branchDeleted,
      });
    } catch (error) {
      skipped.push({
        runId: run.runId,
        reason: isArgosError(error) ? error.code : "worktree_failed",
      });
    }
  }
  return {
    removed,
    skipped,
    orphans: orphanWorktreeDirs(
      input.home,
      new Set(input.runs.map((run) => run.runId)),
    ),
  };
}
