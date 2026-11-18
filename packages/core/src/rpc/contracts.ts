/**
 * The RPC contract (FR26, Phase 8) — the single source of truth for the HTTP server, the CLI
 * client, the Paseo plugin, and the contract tests.
 *
 * Everything here is plain zod + inferred types. Three rules are load-bearing:
 *
 * 1. **No prompts or transcripts.** `RunSummary`/`RunDetail` describe run state (statuses, step
 *    titles, gates, usage counters); the frozen IR, step prompts, and agent messages never cross
 *    this boundary.
 * 2. **Strict bodies.** Request schemas are `strictObject`, so a typo in a field name is a 400,
 *    not a silently ignored write.
 * 3. **Stable codes.** Every error body is `{ error: { code, message, details? } }`; the CLI and
 *    tests match on `code`, never on the message. {@link RPC_ERROR_STATUS} is the one mapping from
 *    a code to an HTTP status.
 *
 * This module imports no durable code: `@thaodangspace/argos-core/rpc` is safe for the CLI and the plugin.
 */

import { z } from "zod";

import { ARGOS_ERROR_CODES } from "../errors.js";
import { ForkedFromSchema, RUN_STATUSES, RunTriggerSchema, STEP_STATUSES } from "../engine/record.js";
import { HISTORY_EVENT_TYPES } from "../history.js";
/**
 * The schedule vocabulary, shared with the scheduler itself (FR1.4, FR3.5, FR5.1, FR9.1).
 * `schedule/model.ts` imports only zod and the error type, so the contract stays free of `croner`
 * and of every durable module: the CLI and the Paseo plugin bundle these schemas and must never
 * arm a timer or open SQLite.
 */
import {
  CatchUpInputSchema,
  CatchUpSchema,
  FireReasonSchema,
  FireStatusSchema,
  KeepSchema,
  MISSED_COUNT_OVERFLOW,
  OverlapSchema,
} from "../schedule/model.js";
/**
 * FR1/FR3/FR8/FR9: the executor vocabulary, re-exported here for the same reason the schedule
 * vocabulary is imported from `schedule/model.ts` — `executor/model.ts` imports only zod and the
 * error type, so the CLI and the Paseo plugin share one normalizer and one info schema without
 * importing the core root, the durable host, or an adapter.
 */
import {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_IDS,
  ExecutorCapabilitiesSchema,
  ExecutorIdSchema,
  ExecutorInfoSchema,
  executorIdFor,
  normalizeExecutorId,
  type ExecutorCapabilities,
  type ExecutorId,
  type ExecutorInfo,
} from "../executor/model.js";

export {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_IDS,
  ExecutorCapabilitiesSchema,
  ExecutorIdSchema,
  ExecutorInfoSchema,
  executorIdFor,
  normalizeExecutorId,
};
export type { ExecutorCapabilities, ExecutorId, ExecutorInfo };

/** Version of the RPC contract; bumped only for a breaking change. */
export const ARGOS_RPC_VERSION = 1;

/**
 * Argos storage/read-model schema version reported by `GET /info` and `argos doctor`. The durable
 * task kinds are still v1 (`argos.run`/`argos.step`/`argos.gate`/`argos.script`).
 */
export const ARGOS_SCHEMA_VERSION = 1;

/** Minimum Node runtime: `node:sqlite` exists from 22.5 but needs no `--experimental-sqlite`
 * only from 22.13, so that is the floor for `argos serve`. */
export const REQUIRED_NODE_VERSION = "22.13";

/** D3 defaults surfaced by `argos doctor` and the server info. */
export const DEFAULT_ARGOS_PORT = 7676;

/** Secret-looking input names are omitted from summaries (`API_KEY`, `*_TOKEN`, …). */
export const SECRET_INPUT_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// ------------------------------------------------------------------ primitives

export const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof ScalarSchema>;

export const ErrorCodeSchema = z.enum(ARGOS_ERROR_CODES);
export type ArgosErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepKindSchema = z.enum(["agent", "gate", "script", "branch", "delay"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const IsolationSchema = z.strictObject({
  mode: z.enum(["none", "worktree"]),
  base: z.string().min(1).optional(),
});
export type Isolation = z.infer<typeof IsolationSchema>;

export const WorktreeSchema = z.strictObject({
  path: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().min(1),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

// ------------------------------------------------------------------ errors

/**
 * The body of every non-2xx response. `code` is an {@link ArgosErrorCode} for domain failures and
 * a small operational set (`invalid_request`, `not_found`, `method_not_allowed`,
 * `internal_error`) for the transport.
 */
export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * The one error-code → HTTP-status map (FR26). Unknown codes are a 500: an unexpected failure is
 * never dressed up as a client error.
 */
export const RPC_ERROR_STATUS: Readonly<Record<string, number>> = {
  // transport
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  internal_error: 500,
  storage_locked: 503,
  // playbooks / models
  playbook_missing: 400,
  playbook_invalid: 422,
  playbook_cycle: 422,
  model_unavailable: 422,
  worktree_base_dirty: 409,
  worktree_failed: 409,
  concurrency_limit: 409,
  // runs / steps / gates
  run_unknown: 404,
  step_unknown: 404,
  gate_unknown: 404,
  gate_already_decided: 409,
  run_terminal: 409,
  loop_limit: 409,
  // FR4: a worktree operation named a run that has not finished yet.
  run_active: 409,
  // Fork: the edited definition cannot be applied at the fork point.
  definition_conflict: 409,
  // FR17: the executor registry. `unavailable` is a refusal, `unreachable` is a transport failure.
  executor_unavailable: 422,
  executor_unreachable: 503,
  // FR1.6/FR1.7: the schedule registry.
  schedule_unknown: 404,
  schedule_exists: 409,
  // runtime failures
  paseo_unreachable: 503,
  provider_exhausted: 503,
  agent_missing: 409,
  launch_uncertain: 409,
  invalid_output: 422,
  readonly_violation: 409,
  // FR3: a pinned script changed after the run started.
  script_changed: 409,
  step_failed: 502,
  step_timeout: 504,
  script_timeout: 504,
};

/** The status for a code, defaulting to 500. */
export function statusForCode(code: string): number {
  return RPC_ERROR_STATUS[code] ?? 500;
}

// ------------------------------------------------------------------ writes

export const StartRunRequestSchema = z.strictObject({
  /** Playbook id (file name without `.yaml`) resolved under `cwd`. */
  playbookId: z.string().min(1),
  inputs: z.record(z.string(), ScalarSchema).optional(),
  /** Repository root the loader reads (and the run works in). Default: the server's cwd. */
  cwd: z.string().min(1).optional(),
  isolation: IsolationSchema.optional(),
  /**
   * FR3: the substrate for this run (`paseo`, `hc`, or an alias such as `herdr-core`). Normalized by
   * the route: a value that is not an executor at all is `400 invalid_request` before the host is
   * called, and a canonical id the server has no adapter for is `422 executor_unavailable`.
   */
  executor: z.string().min(1).optional(),
  /** D15 idempotency key: a repeat returns the first run instead of starting a second. */
  clientRequestId: z.string().min(1).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.strictObject({
  runId: z.string().min(1),
  taskId: z.string().min(1),
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

export const DecideGateRequestSchema = z.strictObject({
  decision: z.string().min(1),
  comment: z.string().optional(),
  decidedBy: z.string().min(1).optional(),
  decidedVia: z.string().min(1).optional(),
  /** Makes a retried decision a no-op success when gate + decision + id all match. */
  clientRequestId: z.string().min(1).optional(),
});
export type DecideGateRequest = z.infer<typeof DecideGateRequestSchema>;

export const GateDecisionResponseSchema = z.strictObject({
  runId: z.string().min(1),
  gateId: z.string().min(1),
  decision: z.string().min(1),
  comment: z.string().optional(),
  decidedBy: z.string().min(1).optional(),
  decidedVia: z.string().min(1).optional(),
  decidedAt: z.number(),
});
export type GateDecisionResponse = z.infer<typeof GateDecisionResponseSchema>;

export const RetryRequestSchema = z.strictObject({
  stepId: z.string().min(1),
});
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

/**
 * `POST /runs/:id/fork`: branch a terminal run at one step, reloading the definition from the
 * run's `cwd`. The response is the same `{runId, taskId}` as a start (a fork **is** a new run),
 * so it reuses {@link StartRunResponseSchema}.
 */
export const ForkRequestSchema = z.strictObject({
  stepId: z.string().min(1),
});
export type ForkRequest = z.infer<typeof ForkRequestSchema>;

export const CancelRunResponseSchema = z.strictObject({
  runId: z.string().min(1),
  status: RunStatusSchema,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

/** `DELETE /runs/:id` (`argos rm`). `worktree` is the checkout left on disk, when the run had one. */
export const RemoveRunResponseSchema = z.strictObject({
  runId: z.string().min(1),
  status: RunStatusSchema,
  worktree: z.string().min(1).optional(),
});
export type RemoveRunResponse = z.infer<typeof RemoveRunResponseSchema>;

/** `POST /runs/:id/worktree/remove` (`argos worktree rm`, FR4.1). Strict: a typo is a 400. */
export const RemoveWorktreeRequestSchema = z.strictObject({
  /** Remove a dirty checkout (FR4.2); default `false` refuses with `worktree_failed`. */
  force: z.boolean().optional(),
  /** Delete `argos/<runId>` too (FR4.3); default `false` keeps the branch. */
  deleteBranch: z.boolean().optional(),
});
export type RemoveWorktreeRequest = z.infer<typeof RemoveWorktreeRequestSchema>;

export const RemoveWorktreeResponseSchema = z.strictObject({
  runId: z.string().min(1),
  /** The record's worktree path; `""` when the run never had one (`removed: false`). */
  path: z.string(),
  removed: z.boolean(),
  branchDeleted: z.boolean(),
});
export type RemoveWorktreeResponse = z.infer<typeof RemoveWorktreeResponseSchema>;

/** `POST /worktrees/gc` (FR4.5). `olderThan` is `<n>(s|m|h|d)`; the server turns it into ms. */
export const GcWorktreesRequestSchema = z.strictObject({
  olderThan: z.string().regex(/^[0-9]+[smhd]$/, "olderThan must be <n>(s|m|h|d), e.g. 24h"),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
});
export type GcWorktreesRequest = z.infer<typeof GcWorktreesRequestSchema>;

export const GcRemovedWorktreeSchema = z.strictObject({
  runId: z.string().min(1),
  path: z.string().min(1),
  branchDeleted: z.boolean(),
});
export type GcRemovedWorktree = z.infer<typeof GcRemovedWorktreeSchema>;

/** A run gc looked at and left alone: `active`, `path_mismatch`, or a stable error code. */
export const GcSkippedWorktreeSchema = z.strictObject({
  runId: z.string().min(1),
  reason: z.string().min(1),
});
export type GcSkippedWorktree = z.infer<typeof GcSkippedWorktreeSchema>;

export const GcWorktreesResponseSchema = z.strictObject({
  removed: z.array(GcRemovedWorktreeSchema),
  skipped: z.array(GcSkippedWorktreeSchema),
  /** Directories under `<home>/worktrees` that no run index entry claims; reported, never deleted. */
  orphans: z.array(z.string().min(1)),
});
export type GcWorktreesResponse = z.infer<typeof GcWorktreesResponseSchema>;

// ------------------------------------------------------------------ database maintenance

/** Bytes on disk of `argos.sqlite` and its WAL (`0` when a file is absent). */
export const DbFileSizesSchema = z.strictObject({
  bytes: z.number().int().min(0),
  walBytes: z.number().int().min(0),
});
export type DbFileSizes = z.infer<typeof DbFileSizesSchema>;

export const DbDocumentKindSchema = z.strictObject({
  kind: z.string().min(1),
  live: z.number().int().min(0),
  retired: z.number().int().min(0),
  bytes: z.number().int().min(0),
});
export type DbDocumentKind = z.infer<typeof DbDocumentKindSchema>;

export const DbTaskKindSchema = z.strictObject({
  kind: z.string().min(1),
  live: z.number().int().min(0),
  terminal: z.number().int().min(0),
  bytes: z.number().int().min(0),
});
export type DbTaskKind = z.infer<typeof DbTaskKindSchema>;

/** `GET /db/stats` (`argos db stats`). Read-only: sizes, page counters, and row counts. */
export const DbStatsSchema = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().min(0),
  walBytes: z.number().int().min(0),
  pageSize: z.number().int().min(0),
  pageCount: z.number().int().min(0),
  /** Pages SQLite can reuse before the file grows (`PRAGMA freelist_count`). */
  freePages: z.number().int().min(0),
  journalMode: z.string().min(1),
  runs: z.strictObject({
    total: z.number().int().min(0),
    active: z.number().int().min(0),
  }),
  documents: z.strictObject({
    total: z.number().int().min(0),
    live: z.number().int().min(0),
    retired: z.number().int().min(0),
    byKind: z.array(DbDocumentKindSchema),
  }),
  tasks: z.strictObject({
    total: z.number().int().min(0),
    live: z.number().int().min(0),
    terminal: z.number().int().min(0),
    byKind: z.array(DbTaskKindSchema),
  }),
  revisions: z.number().int().min(0),
  entries: z.number().int().min(0),
  conversations: z.number().int().min(0),
  submissions: z.number().int().min(0),
  receipts: z.strictObject({
    total: z.number().int().min(0),
    /** Past the 24 h TTL; `purge` retires them. */
    expired: z.number().int().min(0),
  }),
});
export type DbStats = z.infer<typeof DbStatsSchema>;

/** `POST /db/purge` (`argos db purge`). `olderThan` is `<n>(s|m|h|d)` and is required. */
export const DbPurgeRequestSchema = z.strictObject({
  olderThan: z.string().regex(/^[0-9]+[smhd]$/, "olderThan must be <n>(s|m|h|d), e.g. 30d"),
  /** Report what would happen without touching anything. */
  dryRun: z.boolean().optional(),
  /** `VACUUM` after the purge (ignored with `dryRun`). */
  vacuum: z.boolean().optional(),
});
export type DbPurgeRequest = z.infer<typeof DbPurgeRequestSchema>;

export const DbPurgedRunSchema = z.strictObject({
  runId: z.string().min(1),
  status: RunStatusSchema,
  updatedAt: z.number(),
  /** The checkout `removeRun` leaves on disk (a purge never removes worktrees). */
  worktree: z.string().min(1).optional(),
});
export type DbPurgedRun = z.infer<typeof DbPurgedRunSchema>;

/** A run purge left alone: `active`, or the stable code a refused removal raised. */
export const DbPurgeSkippedSchema = z.strictObject({
  runId: z.string().min(1),
  reason: z.string().min(1),
});
export type DbPurgeSkipped = z.infer<typeof DbPurgeSkippedSchema>;

export const DbPurgeResponseSchema = z.strictObject({
  dryRun: z.boolean(),
  olderThanMs: z.number().int().min(0),
  removed: z.array(DbPurgedRunSchema),
  skipped: z.array(DbPurgeSkippedSchema),
  /** Terminal task rows reclaimed for the runs this call removed. */
  tasksRemoved: z.number().int().min(0),
  /** Expired idempotency receipts retired (`dryRun`: the count that would be). */
  receiptsRetired: z.number().int().min(0),
  vacuumed: z.boolean(),
  before: DbFileSizesSchema,
  after: DbFileSizesSchema,
});
export type DbPurgeResponse = z.infer<typeof DbPurgeResponseSchema>;

/** `POST /db/vacuum` (`argos db vacuum`). */
export const DbVacuumResponseSchema = z.strictObject({
  vacuumed: z.literal(true),
  before: DbFileSizesSchema,
  after: DbFileSizesSchema,
});
export type DbVacuumResponse = z.infer<typeof DbVacuumResponseSchema>;

// ------------------------------------------------------------------ read model

export const GateChoiceSummarySchema = z.strictObject({
  label: z.string(),
  comment: z.enum(["none", "optional", "required"]),
  color: z.enum(["primary", "neutral", "success", "warning", "danger"]).optional(),
  goto: z.string().min(1).optional(),
  outcome: z.string().min(1).optional(),
});
export type GateChoiceSummary = z.infer<typeof GateChoiceSummarySchema>;

/** One gate, as the panel and CLI see it. The decision fields are present only once decided. */
export const GateSummarySchema = z.strictObject({
  runId: z.string().min(1),
  gateId: z.string().min(1),
  stepId: z.string().min(1),
  kind: z.enum(["step", "loop_limit", "ask"]),
  question: z.string(),
  choices: z.record(z.string(), GateChoiceSummarySchema),
  status: z.enum(["pending", "decided"]),
  decision: z.string().min(1).optional(),
  decidedBy: z.string().min(1).optional(),
  decidedVia: z.string().min(1).optional(),
  comment: z.string().optional(),
  decidedAt: z.number().optional(),
});
export type GateSummary = z.infer<typeof GateSummarySchema>;

export const StepSummarySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  kind: StepKindSchema,
  status: StepStatusSchema,
  errorCode: ErrorCodeSchema.optional(),
  attemptCount: z.number().int().min(0),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /**
   * Aggregate provider/token accounting of this step's attempts (counters summed, gauges peaked).
   * Absent for a step that never launched and for one whose executor reported nothing — a script
   * or gate step has none. Only agent steps can carry numbers.
   */
  usage: z.record(z.string(), z.number()).optional(),
});
export type StepSummary = z.infer<typeof StepSummarySchema>;

/**
 * One launch attempt of a step (`GET /runs/:id` only). Attempt history is what the panel's step log
 * is built from; `agentId` and `requestId` stay private, `target` is just `provider/model`.
 */
export const StepAttemptSummarySchema = z.strictObject({
  n: z.number().int().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.enum(["completed", "failed", "timeout", "cancelled"]).optional(),
  errorCode: ErrorCodeSchema.optional(),
  /** The `provider/model` the attempt ran on (a script step has none). */
  target: z.string().min(1).optional(),
  /** Provider/token accounting when the executor reported it. */
  usage: z.record(z.string(), z.number()).optional(),
});
export type StepAttemptSummary = z.infer<typeof StepAttemptSummarySchema>;

/**
 * A step as `GET /runs/:id` publishes it: the list fields plus everything a per-step log needs.
 * `outputs` are the step's **declared** outputs (a script's `stdout`, an agent's schema outputs),
 * never a transcript; secret-looking output names are dropped like secret-looking inputs are.
 */
export const StepDetailSummarySchema = StepSummarySchema.extend({
  /** The outcome the step reported (drives `on`/`when` routing), when it settled with one. */
  outcome: z.string().min(1).optional(),
  /** Every attempt, oldest first. Empty for a step that never launched (a gate, a pending step). */
  attempts: z.array(StepAttemptSummarySchema),
  /** Declared outputs, each string bounded to {@link STEP_OUTPUT_VALUE_LIMIT} characters. */
  outputs: z.record(z.string(), ScalarSchema).optional(),
});
export type StepDetailSummary = z.infer<typeof StepDetailSummarySchema>;

/** Longest output value a run detail copies: a script tail is bounded, an agent's may not be. */
export const STEP_OUTPUT_VALUE_LIMIT = 4_000;

export const AfterSummarySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  trigger: z.enum(["auto", "manual"]),
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type AfterSummary = z.infer<typeof AfterSummarySchema>;

/**
 * One run as listed by `argos ls` / `GET /runs`. Deliberately excludes `ir`, prompts, agent
 * messages, and any transcript: only status + display metadata.
 */
export const RunSummarySchema = z.strictObject({
  id: z.string().min(1),
  playbookId: z.string().min(1),
  playbookHash: z.string().min(1),
  status: RunStatusSchema,
  /** Run inputs with secret-looking names removed (never rendered in the UI). */
  inputs: z.record(z.string(), ScalarSchema),
  cwd: z.string().min(1),
  worktree: WorktreeSchema.optional(),
  /** FR8.2: the schedule fire that started the run. Absent on a manual run, so goldens hold. */
  trigger: RunTriggerSchema.optional(),
  /** Fork provenance: present only on a run started by `argos fork`. */
  forkedFrom: ForkedFromSchema.optional(),
  /**
   * FR8: the substrate this run actually used, when it is not `paseo`. A `paseo` run omits the key
   * entirely, so every existing summary/detail and golden stays byte-identical; the value is the
   * canonical id frozen in the run record (never re-resolved from config).
   */
  executor: ExecutorIdSchema.optional(),
  /**
   * Workflow total of provider/token accounting: every main step's {@link StepSummarySchema.usage}
   * aggregated (counters summed, gauges peaked). Absent when no step reported any. After tasks are
   * separate runs and are not counted here.
   */
  usage: z.record(z.string(), z.number()).optional(),
  steps: z.array(StepSummarySchema),
  /** Every gate of the run, pending and decided; the CLI/panel filters pending ones. */
  gates: z.array(GateSummarySchema),
  after: z.array(AfterSummarySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  seq: z.number().int().min(0),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const HistoryEventSchema = z.strictObject({
  at: z.number(),
  seq: z.number().int().min(0),
  /** One of {@link HISTORY_EVENT_TYPES} — `script_repinned` included (FR3.4). */
  type: z.enum(HISTORY_EVENT_TYPES),
  stepId: z.string().nullable(),
  attempt: z.number().int().nullable(),
  detail: z.string().nullable(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/**
 * `GET /runs/:id`. `gates` are the gate documents projected to {@link GateSummary}; `steps` carry
 * the attempt/output detail the panel renders as a step log; `history` is the bounded (≤500) event
 * log. Still no prompts or transcripts.
 */
export const RunDetailSchema = RunSummarySchema.extend({
  steps: z.array(StepDetailSummarySchema),
  history: z.array(HistoryEventSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunListResponseSchema = z.strictObject({
  runs: z.array(RunSummarySchema),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const GateListResponseSchema = z.strictObject({
  gates: z.array(GateSummarySchema),
});
export type GateListResponse = z.infer<typeof GateListResponseSchema>;

// ------------------------------------------------------------------ playbooks (spec FR4)

/**
 * One declared input of a playbook, exactly what a "Run workflow" form needs: the name, the type to
 * render, whether it is required, and the default/values to prefill. A default whose name looks like
 * a credential (`SECRET_INPUT_NAME_PATTERN`) is never published, matching the run-summary rule.
 */
export const PlaybookInputSchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "enum"]),
  required: z.boolean(),
  default: ScalarSchema.optional(),
  values: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type PlaybookInput = z.infer<typeof PlaybookInputSchema>;

/**
 * One discoverable playbook. `file` is the path the loader read; `hash` is the frozen IR hash, so a
 * UI can tell that a definition changed between two runs. No prompt, step body, or IR field beyond
 * these crosses the contract.
 */
export const PlaybookSummarySchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().min(1),
  hash: z.string().min(1),
  inputs: z.array(PlaybookInputSchema),
  executor: ExecutorIdSchema.optional(),
  isolation: z.enum(["none", "worktree"]).optional(),
  stepCount: z.number().int().min(0),
});
export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;

/** A playbook under `cwd`/`home` that failed to load. One bad file never hides the others. */
export const PlaybookLoadErrorSchema = z.strictObject({
  file: z.string(),
  code: z.string().min(1),
  message: z.string(),
});
export type PlaybookLoadError = z.infer<typeof PlaybookLoadErrorSchema>;

/** `GET /playbooks?cwd=<absolute dir>` (spec FR4). Read-only: discovery + validation, no task. */
export const PlaybookListResponseSchema = z.strictObject({
  cwd: z.string().min(1),
  playbooks: z.array(PlaybookSummarySchema),
  errors: z.array(PlaybookLoadErrorSchema),
});
export type PlaybookListResponse = z.infer<typeof PlaybookListResponseSchema>;

// ------------------------------------------------------------------ schedules (FR10.1)

/**
 * The isolation a schedule stores: the mode only, never a base ref (FR23/D9). A fire resolves the
 * base the way `--isolation` does, so an edit cannot pin a schedule to a stale commit.
 */
export const ScheduleIsolationModeSchema = z.enum(["none", "worktree"]);
export type ScheduleIsolationMode = z.infer<typeof ScheduleIsolationModeSchema>;

/**
 * `recentRunIds` is bounded on purpose (FR10.1): a detail response must not grow with the 1,000-id
 * `runIds` cap. The first ten are the newest ten, because the document stores them newest first.
 */
export const SCHEDULE_RECENT_RUN_LIMIT = 10;

/**
 * One fire outcome as the wire publishes it (FR1.4). Declared here rather than reused from the
 * document schema so the public shape is pinned: a field the scheduler later adds internally must
 * be a deliberate contract change.
 */
export const ScheduleFireSchema = z.strictObject({
  fireAt: z.number(),
  at: z.number(),
  reason: FireReasonSchema,
  status: FireStatusSchema,
  runId: z.string().min(1).optional(),
  errorCode: z.string().nullable().optional(),
  message: z.string().optional(),
  count: z.union([z.number().int(), z.literal(MISSED_COUNT_OVERFLOW)]).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});
export type ScheduleFire = z.infer<typeof ScheduleFireSchema>;

/**
 * One schedule as `argos schedule ls` and `GET /schedules` see it: the stored document **without**
 * `uid`, `runIds`, and `fires` (FR10.1). `inputs` go through the same secret-name filter as a run
 * summary, so a credential-shaped input never reaches a UI (Security NFR).
 */
export const ScheduleSummarySchema = z.strictObject({
  id: z.string().min(1),
  playbookId: z.string().min(1),
  cwd: z.string().min(1),
  /** Schedule inputs with secret-looking names removed (SECRET_INPUT_NAME_PATTERN). */
  inputs: z.record(z.string(), ScalarSchema),
  isolation: ScheduleIsolationModeSchema.optional(),
  /** FR10: present only for a non-default pinned substrate (a paseo/absent schedule omits it). */
  executor: ExecutorIdSchema.optional(),
  cron: z.string().min(1),
  tz: z.string().min(1),
  overlap: OverlapSchema,
  catchUp: CatchUpSchema,
  keep: KeepSchema,
  enabled: z.boolean(),
  generation: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** `null` only while the schedule is paused (FR7.3). */
  nextFireAt: z.number().nullable(),
  lastFire: ScheduleFireSchema.optional(),
  liveRunId: z.string().min(1).optional(),
  consecutiveFailures: z.number().int().min(0),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

/** `GET /schedules/:id` / a create / an edit: the summary plus the fire log and recent run ids. */
export const ScheduleDetailSchema = ScheduleSummarySchema.extend({
  fires: z.array(ScheduleFireSchema),
  /** The newest {@link SCHEDULE_RECENT_RUN_LIMIT} entries of the document's `runIds`. */
  recentRunIds: z.array(z.string().min(1)),
});
export type ScheduleDetail = z.infer<typeof ScheduleDetailSchema>;

export const ScheduleListResponseSchema = z.strictObject({
  schedules: z.array(ScheduleSummarySchema),
});
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;

/**
 * `POST /schedules` (FR10.1). `playbook` is the playbook id — the host's `AddScheduleInput` calls it
 * `playbookId`. `cwd` is **required** (FR2.5): a schedule is unattended execution, and defaulting it
 * to the server's cwd would make the target depend on how `argos serve` was started.
 */
export const ScheduleCreateRequestSchema = z.strictObject({
  id: z.string().min(1).optional(),
  playbook: z.string().min(1),
  cwd: z.string().min(1),
  inputs: z.record(z.string(), ScalarSchema).optional(),
  isolation: ScheduleIsolationModeSchema.optional(),
  /**
   * FR10: pin the substrate this schedule fires on. A raw string on the wire: the host normalizes
   * aliases (`herdr-core` → `hc`) and refuses an unknown id with `invalid_request`, while a known
   * id nobody registered is `executor_unavailable` from the add-time dry check (FR12).
   */
  executor: z.string().min(1).optional(),
  cron: z.string().min(1),
  tz: z.string().min(1).optional(),
  overlap: OverlapSchema.optional(),
  /** `"all"`, milliseconds, or the CLI shorthand `90m` / `12h` / `2d` (FR3.5). */
  catchUp: CatchUpInputSchema.optional(),
  keep: KeepSchema.optional(),
  /** `false` is `argos schedule add --paused` (FR7.1). */
  enabled: z.boolean().optional(),
});
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>;

/**
 * `POST /schedules/:id` (FR7.2): any stored field except `id`, `uid`, and the playbook. At least one
 * key must be present — a payload that changes nothing is a 400, not a silent `generation` bump, so
 * the CLI cannot "succeed" without doing anything.
 */
export const ScheduleEditRequestSchema = z
  .strictObject({
    cwd: z.string().min(1).optional(),
    inputs: z.record(z.string(), ScalarSchema).optional(),
    isolation: ScheduleIsolationModeSchema.optional(),
    /** FR10: move the pin (same normalization/refusal rules as a create). */
    executor: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    tz: z.string().min(1).optional(),
    overlap: OverlapSchema.optional(),
    catchUp: CatchUpInputSchema.optional(),
    keep: KeepSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message:
      "an edit needs at least one of cwd, inputs, isolation, executor, cron, tz, overlap, catchUp, keep",
  });
export type ScheduleEditRequest = z.infer<typeof ScheduleEditRequestSchema>;

/** `POST /schedules/:id/run` (FR7.6). The body may be absent; the key is the D15 idempotency one. */
export const ScheduleRunRequestSchema = z.strictObject({
  clientRequestId: z.string().min(1).optional(),
});
export type ScheduleRunRequest = z.infer<typeof ScheduleRunRequestSchema>;

/** `DELETE /schedules/:id`. The literal `true` is what makes a refusal impossible to misread. */
export const ScheduleRemoveResponseSchema = z.strictObject({
  id: z.string().min(1),
  removed: z.literal(true),
});
export type ScheduleRemoveResponse = z.infer<typeof ScheduleRemoveResponseSchema>;

// ------------------------------------------------------------------ info / doctor

export const ProviderInfoSchema = z.strictObject({
  provider: z.string().min(1),
  enabled: z.boolean(),
  models: z.array(z.string()),
  error: z.string().optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const PaseoInfoSchema = z.strictObject({
  url: z.string().optional(),
  /** `fake` is the test-only `ARGOS_FAKE_PASEO=1` executor. */
  mode: z.enum(["live", "fake"]).optional(),
  reachable: z.boolean(),
  error: z.string().optional(),
});
export type PaseoInfo = z.infer<typeof PaseoInfoSchema>;

export const RunCountsSchema = z.strictObject({
  total: z.number().int().min(0),
  active: z.number().int().min(0),
});
export type RunCounts = z.infer<typeof RunCountsSchema>;

/** `GET /info` — what `argos doctor` reads from a running server. */
export const ServerInfoSchema = z.strictObject({
  name: z.literal("argos"),
  rpcVersion: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(0),
  home: z.string().optional(),
  node: z.string().min(1),
  startedAt: z.number(),
  uptimeMs: z.number().min(0),
  paseo: PaseoInfoSchema,
  providers: z.array(ProviderInfoSchema),
  /**
   * FR9: every registered executor, `paseo` first. The only key this response gained for the
   * executor registry; every existing key keeps its meaning.
   */
  executors: z.array(ExecutorInfoSchema).optional(),
  pendingGates: z.array(GateSummarySchema),
  runs: RunCountsSchema,
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const DoctorStorageSchema = z.strictObject({
  path: z.string().min(1),
  exists: z.boolean(),
  /** `0700` as a decimal mode, when the home directory exists. */
  homeMode: z.number().int().optional(),
  /** `0600` as a decimal mode, when the database file exists. */
  dbMode: z.number().int().optional(),
});
export type DoctorStorage = z.infer<typeof DoctorStorageSchema>;

export const DoctorCheckSchema = z.strictObject({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorServerSchema = z.strictObject({
  reachable: z.boolean(),
  url: z.string().min(1),
  pid: z.number().int().positive().optional(),
  uptimeMs: z.number().min(0).optional(),
});
export type DoctorServer = z.infer<typeof DoctorServerSchema>;

/** `argos doctor --json` — works with or without a running server. */
export const DoctorReportSchema = z.strictObject({
  node: z.strictObject({
    version: z.string().min(1),
    required: z.string().min(1),
    ok: z.boolean(),
  }),
  home: z.string().min(1),
  storage: DoctorStorageSchema,
  schemaVersion: z.number().int().min(1),
  port: z.number().int().min(0),
  server: DoctorServerSchema,
  paseo: PaseoInfoSchema,
  providers: z.array(ProviderInfoSchema),
  /**
   * FR9: the executor registry as the server published it (absent when no server answered). The
   * report's other fields keep their meaning, so a doctor reading an older server is unaffected.
   */
  executors: z.array(ExecutorInfoSchema).optional(),
  pendingGates: z.array(GateSummarySchema),
  runs: RunCountsSchema,
  checks: z.array(DoctorCheckSchema),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

// ------------------------------------------------------------------ CLI validation

export const ValidatePlaybookSchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().min(1),
  hash: z.string().min(1),
});
export type ValidatePlaybook = z.infer<typeof ValidatePlaybookSchema>;

export const ValidateErrorSchema = z.strictObject({
  file: z.string(),
  stepId: z.string().nullable(),
  code: z.string().min(1),
  message: z.string(),
});
export type ValidateError = z.infer<typeof ValidateErrorSchema>;

/**
 * FR7.2 warning codes, all of them already in the contract so later phases only start emitting.
 * `warnings.test.ts` asserts this list matches the loader's `WARNING_CODES`.
 */
export const ValidateWarningCodeSchema = z.enum([
  "alias_conflict",
  "alias_deprecated",
  "unknown_key",
  "env_inherit_all",
  "env_denied",
  "role_shadowed",
  "playbook_shadowed",
]);
export type ValidateWarningCode = z.infer<typeof ValidateWarningCodeSchema>;

/** One non-fatal finding (FR7.1). Never carries a YAML value, only keys, ids, and paths. */
export const ValidateWarningSchema = z.strictObject({
  file: z.string(),
  stepId: z.string().nullable(),
  code: ValidateWarningCodeSchema,
  message: z.string(),
});
export type ValidateWarning = z.infer<typeof ValidateWarningSchema>;

export const ValidateReportSchema = z.strictObject({
  valid: z.boolean(),
  playbooks: z.array(ValidatePlaybookSchema),
  errors: z.array(ValidateErrorSchema),
  /** Warnings never change `valid` or the exit code (FR7.1). */
  warnings: z.array(ValidateWarningSchema),
});
export type ValidateReport = z.infer<typeof ValidateReportSchema>;

/** SSE frame names (FR26). */
export const SSE_SNAPSHOT_EVENT = "snapshot";
export const SSE_RUN_EVENT = "run";
