/**
 * `argos.step` v1 — one child task per launched step attempt.
 *
 * Phases: `locate → launch → await → collect` (FR16).
 *
 * - `locate` commits the launch intent (`requestId`, label, deadline) **before** any executor call.
 *   The intent lives in the checkpoint, so a restart reuses the same request id and the same
 *   attempt number, which is what makes `launch` an adopt-or-create decision instead of a
 *   duplicate agent.
 * - `launch` calls the injected {@link StepExecutor} and commits `agentId` immediately
 *   (the reconcile point).
 * - `await` parks in `sleeping(until: now + pollMs)`; it never holds a turn or a real timer.
 * - `collect` normalizes outputs and commits a **terminal** task with a {@link StepTaskResult}.
 *   A failed step is a completed task carrying an `errorCode`: task failure stays reserved for
 *   broken task code.
 *
 * D8 read-only guard (FR23): when the step's role is `readonly`, `locate` snapshots the working
 * tree **before** launch and `collect` compares it after the turn. Any difference fails the step
 * with `readonly_violation`; the worktree is never cleaned up, so the damage stays inspectable.
 * The mechanism detects, it does not prevent (see `src/git/snapshot.ts`).
 *
 * Timeouts and retries are enforced here because the run task is parked in `waiting` on its
 * children and does not tick. `retries` counts *extra* attempts (engine semantics); each retry
 * gets a fresh `requestId` and a deterministic 1s/2s/4s… backoff. The run record still records one
 * dispatch attempt per child task; the step task's own retries are visible in its checkpoint and
 * history. A local retry id is `<dispatchRequestId>.<k>`: the engine's attempt counter and this
 * task's local counter are independent, so sharing one namespace let a later dispatch reuse the
 * request id of a finished retry and adopt that agent. (Phase 5/6 can move retry scheduling back
 * into the engine once the host wakes parked runs on backoff.)
 *
 * A **transient** executor outage at launch does not consume `retries`: no agent ran, so the step
 * parks and re-enters `launch` with the same `requestId` (the adopt-or-create path), bounded by
 * the step deadline, and fails with the transient code — never `step_timeout`. Because the retry
 * is a create re-entry (`priorCreateAttempt`), an agent or hc terminal that the failed call already
 * created is adopted instead of duplicated, while a daemon that cannot filter labels refuses with
 * `launch_uncertain` rather than risk the duplicate. The checkpoint's
 * `launchFailures`/`launchErrorCode` are the evidence; a later success keeps the count and drops
 * the code, and the deadline receipt's `detail` reads
 * `launch failed <n> time(s); last: <code>; step deadline reached`.
 */

import { defineTask } from "@earendil-works/pi-durable";

import { isArgosError, type ArgosErrorCode } from "../../errors.js";
import { DEFAULT_EXECUTOR_ID, type ExecutorId } from "../../executor/model.js";
import type { OutputDefIR, Scalar } from "../../playbook/ir.js";
import { retryBackoffMs } from "../../engine/index.js";
import type { GitRunner } from "../../git/exec.js";
import {
  describeSnapshotChange,
  snapshotChanged,
  takeSnapshot,
  type GitSnapshot,
  type SnapshotComparison,
} from "../../git/snapshot.js";
import {
  launchLabel,
  type AgentStatusInput,
  type AgentStepConfig,
  type CollectResult,
  type ExhaustedTarget,
  type StepAgentStatus,
  type StepExecutor,
  type StepTaskResult,
} from "../context.js";

// ------------------------------------------------------------------ shape

/** Same default as the Paseo executor's quota window (FR24: 15 min). */
const DEFAULT_QUOTA_WINDOW_MS = 15 * 60_000;
/** Never re-poll a blocked provider in a tight loop. */
const MIN_QUOTA_WAIT_MS = 30_000;

/**
 * The one set of codes that mean "the substrate is transiently down" (Paseo's daemon, an hc
 * core), shared by both phases. What differs is what happens at the deadline:
 *
 * - at **launch** nothing ran yet, so the step parks and re-enters the same adopt-or-create launch
 *   (same `requestId`) until the step deadline, then fails with the transient code — the code names
 *   the substrate that was down, never `step_timeout`;
 * - at **poll** the agent attempt exists, so the deadline/`retries` machinery owns the outcome and
 *   a step that never settles fails `step_timeout`.
 */
const TRANSIENT_EXECUTOR_CODES: ReadonlySet<ArgosErrorCode> = new Set<ArgosErrorCode>([
  "paseo_unreachable",
  "executor_unreachable",
]);

export type StepPhase = "locate" | "launch" | "await" | "collect";

export interface StepTaskInput {
  readonly runId: string;
  readonly stepId: string;
  /** Engine dispatch attempt (D14: the task's first `requestId` uses it). */
  readonly attempt: number;
  readonly requestId: string;
  readonly cwd: string;
  /**
   * FR7: the substrate the run froze at start (`RunRecord.executor`, `paseo` when absent). The
   * task commits it to its checkpoint in `locate`, so a restart resumes the same executor even
   * when the server's default changed.
   */
  readonly executor?: string;
  /** D3 step poll default 3000 ms (resolved by the run task from the frozen IR). */
  readonly pollMs: number;
  readonly timeoutMs: number;
  /** Extra attempts after the first (engine semantics). */
  readonly retries: number;
  readonly target?: string;
  readonly prompt?: string;
  /** Feedback from the loop/gate that re-queued this step (`{{ feedback }}`). */
  readonly feedback?: string;
  readonly outcomes: readonly string[];
  readonly outputs: readonly string[];
  /** Output definitions for the structured-result schema (D12). */
  readonly outputDefs: Readonly<Record<string, OutputDefIR>>;
  /** Ordered `provider/model` candidates: preferred target then role fallbacks (FR24). */
  readonly targets?: readonly string[];
  /** Provider settings of the preferred target. */
  readonly agentConfig?: AgentStepConfig;
  /** Targets the run already recorded as quota-exhausted (FR24). */
  readonly exhausted?: readonly ExhaustedTarget[];
  /** D8: `role.readonly` — snapshot before launch, refuse any change after the turn. */
  readonly readonly?: boolean;
  /** `providers.exhausted_for`: how long an exhausted target is skipped (executor default if absent). */
  readonly quotaWindowMs?: number;
  /** `providers.on_exhausted`: `wait` parks the step until a target leaves its window; default `fail`. */
  readonly onExhausted?: "fail" | "wait";
  /** `providers.max_wait`: total quota wait budget of the step; absent = unbounded. */
  readonly maxQuotaWaitMs?: number;
}

export interface StepCheckpointFields {
  readonly requestId: string;
  /**
   * FR7: the executor this attempt runs on, copied from the task input in `locate`. Optional, so
   * a checkpoint written before the registry existed keeps working and means `paseo`.
   */
  readonly executor?: string;
  /** Current local attempt (may exceed the input attempt after a retry). */
  readonly attempt: number;
  readonly label: string;
  /** Absolute epoch ms after which this local attempt times out. */
  readonly deadlineAt: number;
  readonly polls: number;
  /**
   * True once the `launch` phase has begun. Committed **before** the executor call: with an
   * unsupported label filter, a re-entry that sees this flag must fail `launch_uncertain`
   * instead of creating a possible duplicate (the crash window, FR16).
   */
  readonly launchAttempted: boolean;
  /**
   * FR5: how many consecutive transient launch failures this step has parked on. Written only on
   * a transient `launch` failure (an absent key means zero), incremented per retry, and kept after
   * a later success as the step's outage history — so a checkpoint of a step that never hit the
   * case stays byte-identical to one written before this field existed.
   */
  readonly launchFailures?: number;
  /** FR5: the code of the last transient launch failure; dropped by the successful launch commit. */
  readonly launchErrorCode?: ArgosErrorCode;
  /** True after the one allowed handover relaunch (agent archived mid-step). */
  readonly handoverAttempted?: boolean;
  readonly agentId?: string;
  readonly target?: string;
  readonly launchedAt?: number;
  /** Quota-exhausted targets seen by earlier invocations of this step (FR24). */
  readonly exhausted: readonly ExhaustedTarget[];
  /** The polled result, carried into `collect`. */
  readonly status?: StepAgentStatus;
  readonly errorCode?: ArgosErrorCode;
  /** D8: working-tree snapshot taken before launch (read-only steps only). */
  readonly snapshotBefore?: GitSnapshot;
  /** D8: what the comparison found, committed before the terminal `readonly_violation`. */
  readonly readonlyViolation?: SnapshotComparison;
  /** Human-readable reason for a failure; the run record only carries the stable code. */
  readonly detail?: string;
  /** Fresh attempts started after a quota wait; they do not consume `retries`. */
  readonly quotaRelaunches?: number;
  /** When this step first parked on `provider_exhausted` (the `max_wait` clock). */
  readonly quotaWaitSince?: number;
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type StepCheckpoint =
  | (StepCheckpointFields & { readonly phase: "locate" })
  | (StepCheckpointFields & { readonly phase: "launch" })
  | (StepCheckpointFields & { readonly phase: "await" })
  | (StepCheckpointFields & { readonly phase: "collect" });

// ------------------------------------------------------------------ helpers

/** Race an executor promise against the invocation's abort signal (close/abort must not hang). */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("argos: invocation aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("argos: invocation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Drop non-scalar outputs instead of corrupting the checkpoint; report `invalid_output`. */
function normalizeOutputs(
  outputs: Readonly<Record<string, unknown>> | undefined,
): { readonly outputs?: Readonly<Record<string, Scalar>>; readonly invalid: boolean } {
  if (outputs === undefined) return { invalid: false };
  const clean: Record<string, Scalar> = {};
  let invalid = false;
  for (const [key, value] of Object.entries(outputs)) {
    if (isScalar(value)) clean[key] = value;
    else invalid = true;
  }
  return invalid ? { invalid } : { outputs: clean, invalid };
}

function buildResult(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  collected: CollectResult,
): StepTaskResult {
  const normalized = normalizeOutputs(collected.outputs);
  const errorCode = normalized.invalid ? "invalid_output" : collected.errorCode;
  const exhausted = mergeExhausted(checkpoint.exhausted, collected.exhausted ?? []);
  const result: Record<string, unknown> = {
    stepId: input.stepId,
    attempt: checkpoint.attempt,
    requestId: checkpoint.requestId,
  };
  if (collected.outcome !== undefined && errorCode === undefined) result["outcome"] = collected.outcome;
  if (normalized.outputs !== undefined) result["outputs"] = normalized.outputs;
  if (errorCode !== undefined) result["errorCode"] = errorCode;
  if (checkpoint.agentId !== undefined) result["agentId"] = checkpoint.agentId;
  if (checkpoint.target !== undefined) result["target"] = checkpoint.target;
  if (collected.usage !== undefined) result["usage"] = collected.usage;
  if (collected.feedback !== undefined) result["feedback"] = collected.feedback;
  if (collected.detail !== undefined) result["detail"] = collected.detail;
  if (exhausted.length > 0) result["exhausted"] = exhausted;
  return result as unknown as StepTaskResult;
}

/**
 * Merge quota-exhausted targets, keeping one entry per target and the latest `at` (FR24). Insertion
 * order is stable, so the run record's `exhausted` list is deterministic.
 */
function mergeExhausted(
  current: readonly ExhaustedTarget[],
  incoming: readonly ExhaustedTarget[],
): readonly ExhaustedTarget[] {
  if (incoming.length === 0) return current;
  const merged = new Map<string, number>();
  for (const entry of current) merged.set(entry.target, entry.at);
  for (const entry of incoming) {
    merged.set(entry.target, Math.max(merged.get(entry.target) ?? 0, entry.at));
  }
  return [...merged.entries()].map(([target, at]) => ({ target, at }));
}

/** Distinguish a stale checkpoint from a genuinely broken task. */
function isExhaustedTarget(value: unknown): value is ExhaustedTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { target?: unknown }).target === "string" &&
    typeof (value as { at?: unknown }).at === "number"
  );
}

/** Quota entries carried by a thrown executor error (all targets blocked, FR24). */
function errorExhausted(error: unknown): readonly ExhaustedTarget[] {
  const raw = (error as { exhausted?: unknown }).exhausted;
  return Array.isArray(raw) ? raw.filter(isExhaustedTarget) : [];
}

/**
 * Map a thrown executor error to a step result. A port/adaptor throw is a **step** failure with
 * its stable code (e.g. `provider_exhausted`, `launch_uncertain`), not a task fault.
 */
function failureStatus(error: unknown): StepAgentStatus {
  const exhausted = errorExhausted(error);
  const code: ArgosErrorCode = isArgosError(error) ? error.code : "step_failed";
  return {
    state: "done",
    errorCode: code,
    ...(exhausted.length === 0 ? {} : { exhausted }),
  };
}

/** The agent context shared by launch, status, and collect. */
function agentContext(input: StepTaskInput, checkpoint: StepCheckpoint) {
  return {
    requestId: checkpoint.requestId,
    label: checkpoint.label,
    runId: input.runId,
    stepId: input.stepId,
    attempt: checkpoint.attempt,
    cwd: input.cwd,
    outcomes: input.outcomes,
    outputs: input.outputs,
    outputDefs: input.outputDefs,
    ...(checkpoint.target === undefined ? {} : { target: checkpoint.target }),
    ...(input.targets === undefined ? {} : { targets: input.targets }),
    ...(input.agentConfig === undefined ? {} : { agentConfig: input.agentConfig }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
    ...(checkpoint.exhausted.length === 0 ? {} : { exhausted: checkpoint.exhausted }),
    ...(input.quotaWindowMs === undefined ? {} : { quotaWindowMs: input.quotaWindowMs }),
  };
}

function statusInput(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  agentId: string,
): AgentStatusInput {
  return {
    ...agentContext(input, checkpoint),
    agentId,
    ...(checkpoint.handoverAttempted === true ? { handoverAttempted: true } : {}),
  };
}

/** Commit a "step done" checkpoint that `collect` turns into a terminal result. */
function doneCheckpoint(
  checkpoint: StepCheckpoint,
  status: StepAgentStatus,
): StepCheckpoint {
  return {
    ...checkpoint,
    phase: "collect",
    status,
    exhausted: mergeExhausted(
      checkpoint.exhausted,
      status.exhausted ?? [],
    ),
    ...(status.state === "running" && status.agentId !== undefined
      ? { agentId: status.agentId }
      : {}),
  };
}

/**
 * Request id of one local attempt inside a dispatched step.
 *
 * The engine and this task count attempts independently: the run record only records *dispatch*
 * attempts (`n = attempts.length + 1`), while retries and quota waits advance `checkpoint.attempt`
 * invisibly to it. Both used to render the same `argos:<runId>:<stepId>:<n>` id, so the next
 * dispatch could reuse the request id of an earlier local retry; `launch` then adopted that
 * finished agent instead of creating a fresh one (29 ms `step_failed`). The first local attempt
 * keeps the engine's id (stable across restarts, unchanged for every non-retrying step); a retry
 * gets a `.<k>` suffix that a dispatch attempt can never produce.
 */
function localRequestId(input: StepTaskInput, attempt: number): string {
  const local = attempt - input.attempt;
  return local <= 0 ? input.requestId : `${input.requestId}.${local}`;
}

/** A fresh local attempt: new request id/label, backoff, and a clean crash/launch window. */
function retryCheckpoint(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  now: number,
  attempt: number,
): StepCheckpoint {
  return {
    phase: "launch",
    requestId: localRequestId(input, attempt),
    attempt,
    label: launchLabel(input.runId, input.stepId, attempt),
    deadlineAt: now + retryBackoffMs(checkpoint.attempt) + input.timeoutMs,
    polls: 0,
    launchAttempted: false,
    exhausted: checkpoint.exhausted,
    // FR7: a local retry stays on the run's frozen substrate; a fresh checkpoint must not fall
    // back to the server default.
    ...(checkpoint.executor === undefined ? {} : { executor: checkpoint.executor }),
    // D8: the "before" snapshot belongs to the whole read-only step, not to one attempt, so a retry
    // must not forget it (every attempt has to leave the tree alone).
    ...(checkpoint.snapshotBefore === undefined ? {} : { snapshotBefore: checkpoint.snapshotBefore }),
    ...(checkpoint.target === undefined ? {} : { target: checkpoint.target }),
    ...(checkpoint.quotaRelaunches === undefined ? {} : { quotaRelaunches: checkpoint.quotaRelaunches }),
    ...(checkpoint.quotaWaitSince === undefined ? {} : { quotaWaitSince: checkpoint.quotaWaitSince }),
  };
}

/** Local attempts that count against `retries` (quota relaunches are free, FR24). */
function retryAttempts(checkpoint: StepCheckpoint): number {
  return checkpoint.attempt - (checkpoint.quotaRelaunches ?? 0);
}

/**
 * `providers.on_exhausted: wait`: instead of failing `provider_exhausted`, park until the first
 * candidate leaves its exhaustion window and relaunch as a fresh attempt (new request id, so the
 * archived quota agent is never adopted). Returns `undefined` when the step must fail: the policy
 * is `fail`, the ledger is empty, or the wait would exceed `max_wait`.
 */
function quotaWait(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  status: StepAgentStatus,
  now: number,
): { readonly until: number; readonly checkpoint: StepCheckpoint } | undefined {
  if (status.state !== "done" || status.errorCode !== "provider_exhausted") return undefined;
  if (input.onExhausted !== "wait") return undefined;
  const ledger = mergeExhausted(checkpoint.exhausted, status.exhausted ?? []);
  const windowMs = input.quotaWindowMs ?? DEFAULT_QUOTA_WINDOW_MS;
  const candidates = [...new Set([...(input.target === undefined ? [] : [input.target]), ...(input.targets ?? [])])];
  const reopens = candidates.map((target) => {
    const at = ledger.find((entry) => entry.target === target)?.at;
    return at === undefined ? now : at + windowMs;
  });
  if (reopens.length === 0) return undefined;
  const until = Math.max(now + MIN_QUOTA_WAIT_MS, Math.min(...reopens));
  const since = checkpoint.quotaWaitSince ?? now;
  if (input.maxQuotaWaitMs !== undefined && until - since > input.maxQuotaWaitMs) {
    return undefined;
  }
  const attempt = checkpoint.attempt + 1;
  const next: StepCheckpoint = {
    ...retryCheckpoint(input, { ...checkpoint, exhausted: ledger }, now, attempt),
    deadlineAt: until + input.timeoutMs,
    quotaRelaunches: (checkpoint.quotaRelaunches ?? 0) + 1,
    quotaWaitSince: since,
    detail: `waiting for a provider quota window until ${new Date(until).toISOString()}${
      status.feedback === undefined ? "" : ` (${status.feedback})`
    }`,
  };
  // The fresh attempt launches the preferred target again, not whichever fallback ran last.
  const reset: StepCheckpoint =
    input.target === undefined ? next : { ...next, target: input.target };
  return { until, checkpoint: reset };
}

/**
 * FR1–FR4/FR6/FR7: a **transient** executor failure at launch parks the step instead of failing
 * it. Nothing ran, so the retry keeps every identity field (`requestId`, `attempt`, label,
 * `launchAttempted`, `deadlineAt`, `executor`, the read-only snapshot, target, quota bookkeeping)
 * and only records the outage; `retries` is untouched and a new request id is never minted, so a
 * create whose reply was lost is adopted rather than duplicated. The step deadline is the only
 * cap. Returns `undefined` when the failure is not transient or the deadline has passed — the
 * caller then commits the terminal checkpoint with the stable code.
 */
function launchRetry(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  status: StepAgentStatus,
  now: number,
): { readonly until: number; readonly checkpoint: StepCheckpoint } | undefined {
  if (status.state !== "done" || status.errorCode === undefined) return undefined;
  if (!TRANSIENT_EXECUTOR_CODES.has(status.errorCode)) return undefined;
  if (now >= checkpoint.deadlineAt) return undefined;
  const launchFailures = (checkpoint.launchFailures ?? 0) + 1;
  return {
    until: now + retryBackoffMs(launchFailures),
    checkpoint: {
      ...checkpoint,
      phase: "launch",
      launchFailures,
      launchErrorCode: status.errorCode,
    },
  };
}

/** Bounded diagnostic of a launch that never got an agent before the step deadline (FR3). */
function launchDeadlineDetail(checkpoint: StepCheckpoint, code: ArgosErrorCode): string {
  const failures = (checkpoint.launchFailures ?? 0) + 1;
  return `launch failed ${failures} ${failures === 1 ? "time" : "times"}; last: ${code}; step deadline reached`;
}

// ------------------------------------------------------------------ definition

export interface StepTaskOptions {
  /**
   * FR2: every registered executor, keyed by canonical id. `paseo` is always present; a
   * checkpoint naming an id that is not here settles the step `executor_unavailable` (FR6) instead
   * of crashing the task.
   */
  readonly executors: Readonly<Partial<Record<ExecutorId, StepExecutor>>>;
  /** Injected git port for the D8 snapshots (tests); defaults to the `execFile` runner. */
  readonly git?: GitRunner;
}

/** The task instance type the run task creates children from. */
export type StepTaskDefinition = ReturnType<typeof createStepTaskDefinition>;

export function createStepTaskDefinition(options: StepTaskOptions) {
  const { executors } = options;
  const snapshot = (cwd: string): Promise<GitSnapshot> =>
    takeSnapshot(cwd, { ...(options.git === undefined ? {} : { git: options.git }) });

  /** FR7: the executor a checkpoint names; `undefined` when this host cannot run it. */
  const executorFor = (checkpoint: StepCheckpoint): StepExecutor | undefined =>
    executors[(checkpoint.executor ?? DEFAULT_EXECUTOR_ID) as ExecutorId];

  /**
   * FR6: the checkpoint of a step whose substrate is gone. It settles as a **completed** task with
   * `executor_unavailable` (a step failure), exactly like `step_timeout`; the task never faults
   * and the run record keeps the stable code.
   */
  const executorUnavailable = (checkpoint: StepCheckpoint): StepCheckpoint => ({
    ...doneCheckpoint(checkpoint, { state: "done", errorCode: "executor_unavailable" }),
    detail: `executor ${JSON.stringify(
      checkpoint.executor ?? DEFAULT_EXECUTOR_ID,
    )} is not registered on this host`,
  });

  return defineTask<StepTaskInput, StepCheckpoint, StepTaskResult>({
    name: "argos.step",
    version: 1,
    initial: (input): StepCheckpoint => ({
      phase: "locate",
      requestId: input.requestId,
      attempt: input.attempt,
      label: launchLabel(input.runId, input.stepId, input.attempt),
      deadlineAt: 0,
      polls: 0,
      launchAttempted: false,
      exhausted: [],
      ...(input.target === undefined ? {} : { target: input.target }),
    }),

    phases: {
      locate: async (task, runtime, context) => {
        const now = runtime.now();
        let checkpoint: StepCheckpoint = {
          ...task.state.checkpoint,
          phase: "launch",
          deadlineAt: now + task.input.timeoutMs,
          // FR7: the substrate is frozen in the checkpoint here, before any executor call, so a
          // crash/restart resumes the same one even if the server's default has changed.
          ...(task.input.executor === undefined ? {} : { executor: task.input.executor }),
        };
        // D8: the "before" snapshot must be committed before the agent exists. A read-only step in
        // a directory that is not a git working tree cannot be verified, so it fails instead of
        // pretending the guard ran.
        if (task.input.readonly === true) {
          try {
            checkpoint = { ...checkpoint, snapshotBefore: await snapshot(task.input.cwd) };
          } catch (error) {
            checkpoint = {
              ...doneCheckpoint(checkpoint, { state: "done", errorCode: "step_failed" }),
              detail: `cannot verify a read-only step in ${task.input.cwd}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }
        await runtime.commit(() => ({ status: "running", checkpoint }), context);
      },

      launch: async (task, runtime, context) => {
        let checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const executor = executorFor(checkpoint);
        if (executor === undefined) {
          // FR6: no adapter for the frozen id. A step failure, committed before any launch intent.
          await runtime.commit(
            () => ({ status: "running", checkpoint: executorUnavailable(checkpoint) }),
            context,
          );
          return;
        }
        // Commit the launch intent *before* any executor call. A re-entry (crash window) then
        // knows a create may already have happened; with an unsupported label filter the adapter
        // refuses to blind-relaunch (`launch_uncertain`).
        const priorCreateAttempt = checkpoint.launchAttempted === true;
        if (!priorCreateAttempt) {
          checkpoint = { ...checkpoint, launchAttempted: true };
          await runtime.commit(() => ({ status: "running", checkpoint }), context);
        }
        const launchInput = {
          ...agentContext(task.input, checkpoint),
          priorCreateAttempt,
        };
        try {
          const launched = await withAbort(executor.launch(launchInput), runtime.signal);
          // FR9: a step that eventually launched is not carrying an error. The outage count stays
          // (it is a step-level fact); only the code is dropped, so no key is written as undefined.
          const { launchErrorCode: _launchErrorCode, ...settled } = checkpoint;
          const next: StepCheckpoint = {
            ...settled,
            phase: "await",
            agentId: launched.agentId,
            launchedAt: now,
            deadlineAt: now + task.input.timeoutMs,
            polls: 0,
            ...(launched.target === undefined ? {} : { target: launched.target }),
            exhausted: mergeExhausted(checkpoint.exhausted, launched.exhausted ?? []),
          };
          await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // Launch failed: record a step failure (with its stable code), not a task fault.
          const status = failureStatus(error);
          const wait = quotaWait(task.input, checkpoint, status, now);
          if (wait !== undefined) {
            await runtime.commit(
              () => ({ status: "sleeping", until: wait.until, checkpoint: wait.checkpoint }),
              context,
            );
            return;
          }
          // FR1–FR4: a transient outage parks the step and re-enters this phase with the same
          // request id until the step deadline; only the codes decide, never the executor id.
          const retry = launchRetry(task.input, checkpoint, status, now);
          if (retry !== undefined) {
            await runtime.commit(
              () => ({ status: "sleeping", until: retry.until, checkpoint: retry.checkpoint }),
              context,
            );
            return;
          }
          if (
            status.state === "done" &&
            status.errorCode !== undefined &&
            TRANSIENT_EXECUTOR_CODES.has(status.errorCode)
          ) {
            // FR3: the deadline branch names the transient code and how many launches it cost. The
            // detail rides on the status too, so `collect` carries it into the task receipt (the
            // checkpoint itself is dropped when the task settles).
            const detail = launchDeadlineDetail(checkpoint, status.errorCode);
            const failed = doneCheckpoint(checkpoint, { ...status, detail });
            await runtime.commit(
              () => ({ status: "running", checkpoint: { ...failed, detail } }),
              context,
            );
            return;
          }
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
        }
      },

      await: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const executor = executorFor(checkpoint);
        if (executor === undefined) {
          // FR6: a restart on a host that no longer registers the frozen id fails the step with
          // the stable code instead of polling an executor that does not exist.
          await runtime.commit(
            () => ({ status: "running", checkpoint: executorUnavailable(checkpoint) }),
            context,
          );
          return;
        }
        const agentId = checkpoint.agentId;
        if (agentId === undefined) {
          // Defensive: a checkpoint without an agent never polls.
          const status: StepAgentStatus = { state: "done", errorCode: "step_failed" };
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
          return;
        }

        let status: StepAgentStatus;
        try {
          status = await withAbort(
            Promise.resolve(executor.status(statusInput(task.input, checkpoint, agentId))),
            runtime.signal,
          );
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // A transient poll error (daemon/core unreachable) behaves like "still running" and is
          // bounded by the deadline (spec: the step parks and retries with backoff). A terminal
          // executor failure becomes a step failure with its stable code.
          status =
            isArgosError(error) && !TRANSIENT_EXECUTOR_CODES.has(error.code)
              ? failureStatus(error)
              : { state: "running" };
        }

        if (status.state === "done") {
          const wait = quotaWait(task.input, checkpoint, status, now);
          if (wait !== undefined) {
            await runtime.commit(
              () => ({ status: "sleeping", until: wait.until, checkpoint: wait.checkpoint }),
              context,
            );
            return;
          }
          const canRetry =
            status.errorCode === "invalid_output" &&
            retryAttempts(checkpoint) < task.input.attempt + task.input.retries;
          if (canRetry) {
            // Schema-invalid output is retried like a timeout: a fresh agent attempt after a
            // deterministic backoff, bounded by `retries` (FR17).
            const attempt = checkpoint.attempt + 1;
            const retry = retryCheckpoint(task.input, checkpoint, now, attempt);
            await runtime.commit(
              () => ({
                status: "sleeping",
                until: now + retryBackoffMs(checkpoint.attempt),
                checkpoint: retry,
              }),
              context,
            );
            return;
          }
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
          return;
        }

        // A handover relaunch reports the replacement agent; merge it before the next poll.
        const running: StepCheckpoint = {
          ...checkpoint,
          ...(status.agentId === undefined ? {} : { agentId: status.agentId }),
          ...(status.target === undefined ? {} : { target: status.target }),
          ...(status.handover === true ? { handoverAttempted: true } : {}),
          // A poll may report a progress note (`blocked: <msg>` on hc, FR22); the last one stands
          // until the next note arrives.
          ...(status.detail === undefined ? {} : { detail: status.detail }),
          exhausted: mergeExhausted(checkpoint.exhausted, status.exhausted ?? []),
        };

        if (now >= running.deadlineAt) {
          const canRetry = retryAttempts(running) < task.input.attempt + task.input.retries;
          if (!canRetry) {
            const timedOut: StepAgentStatus = { state: "done", errorCode: "step_timeout" };
            await runtime.commit(
              () => ({ status: "running", checkpoint: doneCheckpoint(running, timedOut) }),
              context,
            );
            return;
          }
          const attempt = running.attempt + 1;
          const retry = retryCheckpoint(task.input, running, now, attempt);
          const backoff = retryBackoffMs(running.attempt);
          await runtime.commit(
            () => ({ status: "sleeping", until: now + backoff, checkpoint: retry }),
            context,
          );
          return;
        }

        const sleeping: StepCheckpoint = { ...running, polls: running.polls + 1 };
        await runtime.commit(
          () => ({ status: "sleeping", until: now + task.input.pollMs, checkpoint: sleeping }),
          context,
        );
      },

      collect: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const executor = executorFor(checkpoint);
        if (executor === undefined) {
          // FR6: the adapter is gone between the poll and the collect. Report the stable code
          // rather than a success nothing can substantiate.
          const result = buildResult(task.input, checkpoint, { errorCode: "executor_unavailable" });
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result } }),
            context,
          );
          return;
        }
        const base: CollectResult =
          checkpoint.status === undefined || checkpoint.status.state === "running"
            ? { ...(checkpoint.errorCode === undefined ? {} : { errorCode: checkpoint.errorCode }) }
            : {
                ...(checkpoint.status.outcome === undefined ? {} : { outcome: checkpoint.status.outcome }),
                ...(checkpoint.status.outputs === undefined ? {} : { outputs: checkpoint.status.outputs }),
                ...(checkpoint.status.errorCode === undefined ? {} : { errorCode: checkpoint.status.errorCode }),
                ...(checkpoint.status.usage === undefined ? {} : { usage: checkpoint.status.usage }),
                ...(checkpoint.status.feedback === undefined ? {} : { feedback: checkpoint.status.feedback }),
                ...(checkpoint.status.detail === undefined ? {} : { detail: checkpoint.status.detail }),
                ...(checkpoint.status.exhausted === undefined ? {} : { exhausted: checkpoint.status.exhausted }),
              };

        let collected = base;
        if (executor.collect !== undefined && checkpoint.agentId !== undefined) {
          try {
            const refined = await withAbort(
              Promise.resolve(
                executor.collect({
                  ...statusInput(task.input, checkpoint, checkpoint.agentId),
                  status: checkpoint.status ?? { state: "done" },
                }),
              ),
              runtime.signal,
            );
            collected = {
              ...base,
              ...(refined.outcome === undefined ? {} : { outcome: refined.outcome }),
              ...(refined.outputs === undefined ? {} : { outputs: refined.outputs }),
              ...(refined.errorCode === undefined ? {} : { errorCode: refined.errorCode }),
              ...(refined.usage === undefined ? {} : { usage: refined.usage }),
              ...(refined.feedback === undefined ? {} : { feedback: refined.feedback }),
              ...(refined.detail === undefined ? {} : { detail: refined.detail }),
              ...(refined.exhausted === undefined ? {} : { exhausted: refined.exhausted }),
            };
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            // Keep the polled result; a broken collector must not lose the attempt.
          }
        }

        // D8: a read-only turn that changed the tree never completes. The flagged checkpoint (with
        // the changed paths) is committed before the terminal outcome, so the evidence survives a
        // crash between the two commits and the worktree is left exactly as the step left it.
        if (task.input.readonly === true && collected.errorCode === undefined) {
          try {
            const after = await snapshot(task.input.cwd);
            const comparison =
              checkpoint.snapshotBefore === undefined
                ? { changed: true, headChanged: false, files: [] }
                : snapshotChanged(checkpoint.snapshotBefore, after);
            if (comparison.changed) {
              const flagged: StepCheckpoint = {
                ...checkpoint,
                readonlyViolation: comparison,
                detail: `read-only step changed its working tree: ${describeSnapshotChange(comparison)}`,
              };
              await runtime.commit(
                () => ({ status: "running", checkpoint: flagged }),
                context,
              );
              collected = { errorCode: "readonly_violation" };
            }
          } catch (error) {
            const detail = `cannot verify the read-only guard afterwards: ${
              error instanceof Error ? error.message : String(error)
            }`;
            await runtime.commit(
              () => ({ status: "running", checkpoint: { ...checkpoint, detail } }),
              context,
            );
            collected = { errorCode: "step_failed" };
          }
        }

        const result = buildResult(task.input, checkpoint, collected);
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        );
      },
    },

    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      const result: StepTaskResult = {
        stepId: task.input.stepId,
        attempt: checkpoint.attempt,
        requestId: checkpoint.requestId,
        errorCode: "step_failed",
      };
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result } }),
        context,
      );
    },
  });
}
