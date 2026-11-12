/**
 * Public types of `ArgosHost` (FR5.2 split of `host.ts`, D1).
 *
 * These are the shapes the RPC server, the CLI, and the tests speak: no harness, no SQLite, and
 * no task checkpoint crosses this boundary.
 */

import type { Models } from "@earendil-works/pi-ai/models";
import type { Storage } from "@earendil-works/pi-durable";

import type { RunRecord, WorktreeRecord } from "../engine/index.js";
import type { GitRunner } from "../git/exec.js";
import type { TargetCatalog } from "../paseo/model-catalog.js";
import type { IsolationIR, PlaybookIR, Scalar } from "../playbook/ir.js";
import type { Clock, StepExecutor } from "./context.js";

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
