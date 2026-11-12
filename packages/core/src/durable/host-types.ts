/**
 * Public types of `ArgosHost` (FR5.2 split of `host.ts`, D1).
 *
 * These are the shapes the RPC server, the CLI, and the tests speak: no harness, no SQLite, and
 * no task checkpoint crosses this boundary.
 */

import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, Storage, Tx } from "@earendil-works/pi-durable";

import type { RunRecord, WorktreeRecord } from "../engine/index.js";
import type { RunTrigger } from "../engine/record.js";
import type { GitRunner } from "../git/exec.js";
import type { TargetCatalog } from "../paseo/model-catalog.js";
import type { IsolationIR, PlaybookIR, Scalar } from "../playbook/ir.js";
import type { CatchUpInput, KeepInput, Overlap } from "../schedule/model.js";
import type { Clock, StepExecutor } from "./context.js";
import type { RunDoc } from "./mirror.js";
import type { ScheduleDoc } from "./schedule-docs.js";

export interface ArgosHostOptions {
  /** `$ARGOS_HOME`; default `argosHome()`. Ignored when `storage` is supplied. */
  readonly home?: string;
  /** Injected storage (MemoryStorage in fast unit tests). Skips the home/pid setup. */
  readonly storage?: Storage;
  readonly executor: StepExecutor;
  /** Injected clock; default wall time. The harness clock and every timeout use it. */
  readonly clock?: Clock;
  /** Override the D6 stub (tests only; production leaves it unset). */
  readonly models?: Models;
  /**
   * Provider/model catalog (FR24). When supplied, `startRun` refuses a run whose resolved
   * `provider/model` is missing with `model_unavailable` **before** creating any task. Phase 4
   * tests leave it unset, so the durable host stays independent of Paseo.
   */
  readonly modelCatalog?: TargetCatalog;
  /**
   * Injected git port for worktree creation and read-only snapshots (D9). Production leaves it
   * unset: `execFile("git", [...])` is the only implementation that ships.
   */
  readonly git?: GitRunner;
  /**
   * FR10.4: the fire listener, registered **before** the schedule runner's first tick. `open()`
   * queues that tick, so a catch-up fire that runs while the host is still opening would otherwise
   * finish before a caller could subscribe; `argos serve` passes its stderr line here so every fire
   * outcome is announced, including the first one after a restart.
   */
  readonly onScheduleFire?: ScheduleFireListener;
}

export interface StartRunInput {
  readonly ir: PlaybookIR;
  readonly inputs: Readonly<Record<string, Scalar>>;
  readonly cwd: string;
  readonly worktree?: WorktreeRecord;
  readonly deadline?: number;
  /** Explicit run id (tests / idempotent callers); default `ulid()`. */
  readonly id?: string;
  /**
   * Isolation override for this run (Phase 8's `argos run --isolation`). Default: the frozen IR's
   * `isolation` block, which the loader already resolved from playbook/defaults.
   */
  readonly isolation?: IsolationIR;
  /**
   * D15: idempotency key for `POST /runs`. A repeated request with the same id returns the run the
   * first request created instead of starting a second one.
   */
  readonly clientRequestId?: string;
}

export interface StartedRun {
  readonly runId: string;
  readonly taskId: string;
}

// ------------------------------------------------------------------ start path (FR4.1)

/**
 * Internal start input: the public `StartRunInput` plus the scheduler's provenance (FR8.1).
 *
 * Only the scheduler sets `trigger`; `POST /runs` and the CLI keep the public `StartRunInput`, so a
 * manual run's record stays byte-identical (no `trigger` key at all).
 */
export interface ScheduleRunStartInput extends StartRunInput {
  readonly trigger?: RunTrigger;
}

/** Everything `#commitRun` needs, already resolved and validated by `#prepareRun`. */
export interface PreparedRun {
  readonly runId: string;
  readonly record: RunRecord;
  /** Step 2 of prepare; the idempotency re-check inside the commit uses the same instant. */
  readonly now: number;
  readonly clientRequestId?: string;
}

/**
 * What `#prepareRun` produced. `started` is the D15 idempotency fast path: a retried write that
 * already landed returns the original receipt and creates nothing (not even a worktree).
 */
export type PrepareRunOutcome =
  | { readonly kind: "started"; readonly started: StartedRun }
  | { readonly kind: "prepared"; readonly prepared: PreparedRun };

/** The conversation every run task is owned by (D5). */
export type RunOwnerConversation = Conversation;

export interface CommitRunOptions {
  /** `run_started` history detail: `<playbookId>`, or `<playbookId> (schedule <id>)` (FR4.7). */
  readonly historyDetail: string;
}

/**
 * The start path as the scheduler sees it (`schedules.ts`, Phase 5). A fire prepares outside the
 * commit, then calls `commitInTx` inside the **one** commit that also writes the schedule document,
 * so a crash cannot leave a run without its fire marker (or the other way round).
 *
 * Internal on purpose: it is reachable through `ArgosHost.startPort` and is never exported from
 * `argos-core/durable`.
 */
export interface RunStartPort {
  /** Model check, idempotency fast path, run id, script pins, worktree, record. Never commits. */
  prepare(input: ScheduleRunStartInput): Promise<PrepareRunOutcome>;
  /** Task + mirror + history + run index + idempotency receipt, inside the caller's commit. */
  commitInTx(
    tx: Tx,
    prepared: PreparedRun,
    root: RunOwnerConversation,
    options: CommitRunOptions,
  ): Promise<StartedRun>;
  /** FR2.4 dry check: every prepare step, creating no task, index entry, worktree, or run. */
  dryCheck(input: ScheduleRunStartInput): Promise<void>;
  /** Continue every unfinished task after the caller's commit landed. */
  resume(): void;
  /** The root conversation that owns the run task `commitInTx` creates. */
  root(): Promise<RunOwnerConversation>;
}

/**
 * The two run operations retention needs (FR9.3), supplied by the host so `schedules.ts` never
 * imports `host.ts`: the host stays the only writer of run documents, and the runner only asks.
 *
 * Both are the host's own methods (`getRun`, `removeRun`), so a pruned run is retired exactly the
 * way `argos rm` retires one — the run, history, gate, and idempotency documents plus the index
 * entry, in one commit — and the worktree is left in place for `argos worktree rm`/`gc`.
 */
export interface ScheduleRunPort {
  /** The mirrored run document, or `undefined` for a run the operator already removed. */
  get(runId: string): Promise<RunDoc | undefined>;
  /** `removeRun`: `run_terminal` while the run (or one of its after-tasks) is still going. */
  remove(runId: string): Promise<RemoveRunResult>;
}

/** Where one fire ended (FR6, FR7.6, FR5.2, FR3.6); the same vocabulary as the fire log. */
export type ScheduleFireStatus = "started" | "skipped_overlap" | "refused" | "missed";

/**
 * One fire outcome, as `ArgosHost.observeScheduleFires` announces it (FR10.4).
 *
 * It is exactly what `argos serve` prints on one stderr line: the schedule, the fire time, the
 * status, and either the run it started or the error code that refused it. No input value — and no
 * message text — ever appears here; the fire log inside the document keeps the (bounded) message.
 */
export interface ScheduleFireEvent {
  readonly scheduleId: string;
  readonly fireAt: number;
  readonly status: ScheduleFireStatus;
  readonly runId?: string;
  /** `null` for a failure that was not an `ArgosError` (FR6.2); absent for a non-refusal. */
  readonly errorCode?: string | null;
  /** The missed-fire count, for a `missed` summary (FR3.4). */
  readonly count?: number | "10000+";
}

/** The listener `observeScheduleFires` takes. A throwing listener never breaks the runner (FR10.4). */
export type ScheduleFireListener = (event: ScheduleFireEvent) => void;

/**
 * Options for `argos schedule run` / `POST /schedules/:id/run` (FR7.6). The idempotency key is the
 * same D15 receipt `POST /runs` uses, so a retried run now returns the first receipt.
 */
export interface RunScheduleOptions {
  readonly clientRequestId?: string;
}

/**
 * Result of `removeRun`: the terminal status the run had when it was removed, and the worktree it
 * leaves behind (worktrees are never removed automatically, so the caller can clean it up).
 */
export interface RemoveRunResult {
  readonly runId: string;
  readonly status: RunRecord["status"];
  readonly worktree?: string;
}

/** Result of `cancelRun`: the status the mirrored record reached. */
export interface CancelRunResult {
  readonly runId: string;
  readonly status: RunRecord["status"];
}

/** A run document changed (after-tasks included). Returned by `ArgosHost.observeRuns`. */
export type RunChangeListener = (runId: string) => void;

/** What `decideGate` wrote; idempotent by `gateId` (the first writer wins). */
export interface GateDecisionReceipt {
  readonly runId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt: number;
}

export interface DecideGateOptions {
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  /** D15: makes a retried `POST /runs/:id/gates/:gateId` a no-op success. */
  readonly clientRequestId?: string;
}

/** Result of `startAfterTask` (FR11). `started: false` means it was already started/settled. */
export interface StartedAfterTask {
  readonly runId: string;
  readonly afterId: string;
  readonly started: boolean;
  readonly taskId?: string;
}

// ------------------------------------------------------------------ schedules (FR1, FR2, FR7)

/**
 * What `argos schedule add` / `POST /schedules` supplies (FR1.4, FR2.5).
 *
 * `id` defaults to `playbookId` when that matches {@link SCHEDULE_ID_PATTERN}; `tz` defaults to the
 * zone `argos serve` runs in (FR2.2); `overlap`, `catchUp`, and `keep` fall back to the spec
 * defaults, and `enabled: false` is `--paused` (FR7.1).
 */
export interface AddScheduleInput {
  readonly id?: string;
  readonly playbookId: string;
  readonly cwd: string;
  readonly inputs?: Readonly<Record<string, Scalar>>;
  readonly isolation?: "none" | "worktree";
  readonly cron: string;
  readonly tz?: string;
  readonly overlap?: Overlap;
  readonly catchUp?: CatchUpInput;
  readonly keep?: KeepInput;
  readonly enabled?: boolean;
}

/**
 * What `argos schedule edit` / `POST /schedules/:id` supplies (FR7.2): any stored field except `id`,
 * `uid`, and `playbookId`. At least one key must be present — a payload that changes nothing is
 * `invalid_request` rather than a silent `generation` bump.
 */
export interface EditScheduleInput {
  readonly cwd?: string;
  readonly inputs?: Readonly<Record<string, Scalar>>;
  readonly isolation?: "none" | "worktree";
  readonly cron?: string;
  readonly tz?: string;
  readonly overlap?: Overlap;
  readonly catchUp?: CatchUpInput;
  readonly keep?: KeepInput;
}

/**
 * One schedule as the host hands it to a caller: the complete typed document, including `uid`,
 * `runIds`, and `fires`. The RPC layer narrows this to `ScheduleSummary`/`ScheduleDetail`
 * (FR10.1); the CLI and the tests read it as is.
 */
export type ScheduleView = ScheduleDoc;
