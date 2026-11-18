/**
 * Database maintenance for `argos db` (stats / purge / vacuum).
 *
 * The database is pi-durable's, so three rules keep this module honest:
 *
 * 1. **Reads use SQL, writes use the host.** Stats are plain `SELECT`s over the published schema
 *    (`tasks`, `documents`, `document_revisions`, `entries`, `conversations`, `submissions`) plus
 *    SQLite's own page counters. Removing a run still goes through `ArgosHost.removeRun`, so the
 *    mirror, history, gate, idempotency documents and the runs index retire in one commit — this
 *    module never deletes a document row.
 * 2. **Only what nothing reads.** `purge` considers a run only once it is terminal and its
 *    `updatedAt` is older than the window; a live run is reported as `active` and left alone. Task
 *    rows are deleted only for runs that were removed in the same call, and only when the row is
 *    already `terminal`: `removeRun` deliberately keeps them, and an orphan terminal row serves no
 *    reader once the mirror it belonged to is gone.
 * 3. **Compaction is explicit.** `VACUUM` is its own command (and `--vacuum` on purge), because it
 *    rewrites the whole file and holds the connection while it runs. Nothing here runs on a timer.
 *
 * The two encoded columns matter: pi-durable stores document `kind`/`key_value` as JSON strings
 * (`'"argos.run"'`), so every query decodes them with `json_extract(x, '$')`. Task `kind` is plain
 * text.
 */

import { statSync } from "node:fs";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";

import { isTerminalRunStatus, type RunRecord } from "../engine/index.js";
import {
  ARGOS_IDEMPOTENCY_DOC_KIND,
  ARGOS_RUN_DOC_KIND,
  IDEMPOTENCY_TTL_MS,
} from "./mirror.js";

/** Bytes on disk for the database file and its WAL, when they exist. */
export interface DbFileSizes {
  readonly bytes: number;
  readonly walBytes: number;
}

export interface DbDocumentKind {
  readonly kind: string;
  readonly live: number;
  readonly retired: number;
  /** Sum of the stored row length, a lower bound on what the kind costs. */
  readonly bytes: number;
}

export interface DbTaskKind {
  readonly kind: string;
  readonly live: number;
  readonly terminal: number;
  readonly bytes: number;
}

export interface DbStats extends DbFileSizes {
  /** Absolute path of `argos.sqlite`. */
  readonly path: string;
  readonly pageSize: number;
  readonly pageCount: number;
  /** Pages SQLite can reuse without growing the file (`PRAGMA freelist_count`). */
  readonly freePages: number;
  readonly journalMode: string;
  readonly runs: { readonly total: number; readonly active: number };
  readonly documents: {
    readonly total: number;
    readonly live: number;
    readonly retired: number;
    readonly byKind: readonly DbDocumentKind[];
  };
  readonly tasks: {
    readonly total: number;
    readonly live: number;
    readonly terminal: number;
    readonly byKind: readonly DbTaskKind[];
  };
  readonly revisions: number;
  readonly entries: number;
  readonly conversations: number;
  readonly submissions: number;
  readonly receipts: { readonly total: number; readonly expired: number };
}

/** One run the purge window selected (or, with `dryRun`, would select). */
export interface DbPurgedRun {
  readonly runId: string;
  readonly status: RunRecord["status"];
  readonly updatedAt: number;
  /** The checkout `removeRun` leaves on disk (worktrees are never removed by a purge). */
  readonly worktree?: string;
}

/** A run purge left alone: `active`, or the stable code a refused `removeRun` raised. */
export interface DbPurgeSkipped {
  readonly runId: string;
  readonly reason: string;
}

export interface DbPurgeOptions {
  /** Only runs whose `updatedAt` is older than `now - olderThanMs`. */
  readonly olderThanMs: number;
  /** Report what would be removed without touching anything. */
  readonly dryRun?: boolean;
  /** `VACUUM` after the purge (ignored with `dryRun`). */
  readonly vacuum?: boolean;
}

export interface DbPurgeResult {
  readonly dryRun: boolean;
  readonly olderThanMs: number;
  readonly removed: readonly DbPurgedRun[];
  readonly skipped: readonly DbPurgeSkipped[];
  /** Terminal task rows reclaimed for the runs this call removed. */
  readonly tasksRemoved: number;
  /** Expired `argos.idempotency` receipts retired (`dryRun`: the count that would be). */
  readonly receiptsRetired: number;
  readonly vacuumed: boolean;
  readonly before: DbFileSizes;
  readonly after: DbFileSizes;
}

export interface DbVacuumResult {
  readonly vacuumed: true;
  readonly before: DbFileSizes;
  readonly after: DbFileSizes;
}

/** Size of `path` and its `-wal` sibling; `0` when a file does not exist. */
export function dbFileSizes(path: string): DbFileSizes {
  const size = (candidate: string): number => {
    try {
      return statSync(candidate).size;
    } catch {
      return 0;
    }
  };
  return { bytes: size(path), walBytes: size(`${path}-wal`) };
}

/** The runs the window selects, and the ones it leaves (mirror order is preserved). */
export function selectRunsForPurge(input: {
  readonly runs: readonly { readonly runId: string; readonly record: RunRecord }[];
  readonly now: number;
  readonly olderThanMs: number;
}): { readonly candidates: readonly DbPurgedRun[]; readonly skipped: readonly DbPurgeSkipped[] } {
  const cutoff = input.now - input.olderThanMs;
  const candidates: DbPurgedRun[] = [];
  const skipped: DbPurgeSkipped[] = [];
  for (const run of input.runs) {
    const record = run.record;
    if (record.updatedAt >= cutoff) continue;
    if (!isTerminalRunStatus(record.status)) {
      skipped.push({ runId: run.runId, reason: "active" });
      continue;
    }
    candidates.push({
      runId: run.runId,
      status: record.status,
      updatedAt: record.updatedAt,
      ...(record.worktree === undefined ? {} : { worktree: record.worktree.path }),
    });
  }
  return { candidates, skipped };
}

/** `SELECT` shape helpers (SQLite reports numbers as `number` unless it widened them). */
function num(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

/** Everything `argos db stats` reports. */
export async function collectDbStats(input: {
  readonly db: SqliteExecutor;
  readonly path: string;
  readonly now: number;
}): Promise<DbStats> {
  const { db } = input;
  const [pageSize, pageCount, freelist, journal, docRows, taskRows, revisions, entries, conversations, submissions, runRows, receiptRows] =
    await Promise.all([
      db.get<{ page_size: number }>("PRAGMA page_size"),
      db.get<{ page_count: number }>("PRAGMA page_count"),
      db.get<{ freelist_count: number }>("PRAGMA freelist_count"),
      db.get<{ journal_mode: string }>("PRAGMA journal_mode"),
      db.all<{ kind: string; total: number; live: number; bytes: number }>(
        `SELECT json_extract(kind, '$') AS kind,
                COUNT(*) AS total,
                SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END) AS live,
                SUM(LENGTH(record)) AS bytes
         FROM documents
         GROUP BY 1
         ORDER BY 1`,
      ),
      db.all<{ kind: string; total: number; terminal: number; bytes: number }>(
        `SELECT json_extract(kind, '$') AS kind,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'terminal' THEN 1 ELSE 0 END) AS terminal,
                SUM(LENGTH(record)) AS bytes
         FROM tasks
         GROUP BY 1
         ORDER BY 1`,
      ),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM document_revisions"),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entries"),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations"),
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions"),
      db.all<{ status: string | null; n: number }>(
        `SELECT json_extract(r.content, '$.record.status') AS status, COUNT(*) AS n
         FROM documents d
         JOIN document_revisions r ON r.document_id = d.id
           AND r.seq = (SELECT MAX(seq) FROM document_revisions x WHERE x.document_id = d.id)
         WHERE json_extract(d.kind, '$') = ? AND d.retired_at IS NULL
         GROUP BY 1`,
        ARGOS_RUN_DOC_KIND,
      ),
      db.get<{ total: number; expired: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN json_extract(r.content, '$.createdAt') < ? THEN 1 ELSE 0 END) AS expired
         FROM documents d
         JOIN document_revisions r ON r.document_id = d.id
           AND r.seq = (SELECT MAX(seq) FROM document_revisions x WHERE x.document_id = d.id)
         WHERE json_extract(d.kind, '$') = ? AND d.retired_at IS NULL`,
        input.now - IDEMPOTENCY_TTL_MS,
        ARGOS_IDEMPOTENCY_DOC_KIND,
      ),
    ]);

  let runsTotal = 0;
  let runsActive = 0;
  for (const row of runRows) {
    runsTotal += num(row.n);
    // A null status is an unreadable document; treat it as active rather than claiming it finished.
    if (row.status === null || !isTerminalRunStatus(row.status as RunRecord["status"])) {
      runsActive += num(row.n);
    }
  }

  let docTotal = 0;
  let docLive = 0;
  let docRetired = 0;
  const documentsByKind: DbDocumentKind[] = docRows.map((row) => {
    const total = num(row.total);
    const live = num(row.live);
    docTotal += total;
    docLive += live;
    docRetired += total - live;
    return { kind: row.kind, live, retired: total - live, bytes: num(row.bytes) };
  });

  let taskTotal = 0;
  let taskLive = 0;
  let taskTerminal = 0;
  const tasksByKind: DbTaskKind[] = taskRows.map((row) => {
    const total = num(row.total);
    const terminal = num(row.terminal);
    taskTotal += total;
    taskTerminal += terminal;
    taskLive += total - terminal;
    return { kind: row.kind, live: total - terminal, terminal, bytes: num(row.bytes) };
  });

  const sizes = dbFileSizes(input.path);
  return {
    path: input.path,
    bytes: sizes.bytes,
    walBytes: sizes.walBytes,
    pageSize: num(pageSize?.page_size),
    pageCount: num(pageCount?.page_count),
    freePages: num(freelist?.freelist_count),
    journalMode: journal?.journal_mode ?? "unknown",
    runs: { total: runsTotal, active: runsActive },
    documents: { total: docTotal, live: docLive, retired: docRetired, byKind: documentsByKind },
    tasks: { total: taskTotal, live: taskLive, terminal: taskTerminal, byKind: tasksByKind },
    revisions: num(revisions?.n),
    entries: num(entries?.n),
    conversations: num(conversations?.n),
    submissions: num(submissions?.n),
    receipts: { total: num(receiptRows?.total), expired: num(receiptRows?.expired) },
  };
}

/** The `clientRequestId`s whose receipt is older than the TTL (still live documents). */
export async function expiredReceiptKeys(input: {
  readonly db: SqliteExecutor;
  readonly now: number;
}): Promise<readonly string[]> {
  const rows = await input.db.all<{ key: string }>(
    `SELECT json_extract(d.key_value, '$') AS key
     FROM documents d
     JOIN document_revisions r ON r.document_id = d.id
       AND r.seq = (SELECT MAX(seq) FROM document_revisions x WHERE x.document_id = d.id)
     WHERE json_extract(d.kind, '$') = ? AND d.retired_at IS NULL
       AND json_extract(r.content, '$.runId') <> ''
       AND json_extract(r.content, '$.createdAt') < ?`,
    ARGOS_IDEMPOTENCY_DOC_KIND,
    input.now - IDEMPOTENCY_TTL_MS,
  );
  return rows.map((row) => row.key).filter((key) => key !== "");
}

/**
 * How many terminal task rows a purge would reclaim for these runs. Reported on a `dryRun` so the
 * operator sees the real win (run documents are a fraction of the file; task checkpoints are most
 * of it).
 */
export async function countTasksForRuns(
  db: SqliteExecutor,
  runIds: readonly string[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status = 'terminal'
       AND json_extract(record, '$.input.runId') IN (SELECT value FROM json_each(?))`,
    JSON.stringify(runIds),
  );
  return num(row?.n);
}

/**
 * Delete the terminal task rows of runs a purge just removed, plus their `record_ids` claims.
 * Returns how many task rows went. Ids are never recycled (pi-durable mints them from a monotonic
 * counter), so dropping a claim cannot collide with a future row; a live row is never touched.
 */
export async function deleteTasksForRuns(
  db: SqliteExecutor,
  runIds: readonly string[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  const keys = JSON.stringify(runIds);
  const rows = await db.all<{ id: number }>(
    `SELECT id
     FROM tasks
     WHERE status = 'terminal'
       AND json_extract(record, '$.input.runId') IN (SELECT value FROM json_each(?))`,
    keys,
  );
  if (rows.length === 0) return 0;
  const ids = JSON.stringify(rows.map((row) => row.id));
  await db.run(`DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))`, ids);
  await db.run(
    `DELETE FROM record_ids WHERE record_type = 'task' AND id IN (SELECT value FROM json_each(?))`,
    ids,
  );
  return rows.length;
}

/**
 * Reclaim file pages and truncate the WAL. `VACUUM` rewrites the whole database, so it blocks the
 * event loop for its duration and needs no open transaction; the caller makes it opt-in.
 */
export async function vacuumDatabase(db: SqliteExecutor): Promise<void> {
  // `VACUUM` rewrites every page, and in WAL mode those pages go through the log; the truncating
  // checkpoint must therefore run **after** it, or the file is compact but the WAL still holds a
  // copy of everything and the on-disk total does not shrink.
  await db.exec("VACUUM");
  await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
