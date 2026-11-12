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
 * history. (Phase 5/6 can move retry scheduling back into the engine once the host wakes parked
 * runs on backoff.)
 */

import { defineTask } from "@earendil-works/pi-durable";

import { isArgosError, type ArgosErrorCode } from "../../errors.js";
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
  stepRequestId,
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

export type StepPhase = "locate" | "launch" | "await" | "collect";

export interface StepTaskInput {
  readonly runId: string;
  readonly stepId: string;
  /** Engine dispatch attempt (D14: the task's first `requestId` uses it). */
  readonly attempt: number;
  readonly requestId: string;
  readonly cwd: string;
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

/** A fresh local attempt: new request id/label, backoff, and a clean crash/launch window. */
function retryCheckpoint(
  input: StepTaskInput,
  checkpoint: StepCheckpoint,
  now: number,
  attempt: number,
): StepCheckpoint {
  return {
    phase: "launch",
    requestId: stepRequestId(input.runId, input.stepId, attempt),
    attempt,
    label: launchLabel(input.runId, input.stepId, attempt),
    deadlineAt: now + retryBackoffMs(checkpoint.attempt) + input.timeoutMs,
    polls: 0,
    launchAttempted: false,
    exhausted: checkpoint.exhausted,
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

// ------------------------------------------------------------------ definition

export interface StepTaskOptions {
  readonly executor: StepExecutor;
  /** Injected git port for the D8 snapshots (tests); defaults to the `execFile` runner. */
  readonly git?: GitRunner;
}

/** The task instance type the run task creates children from. */
export type StepTaskDefinition = ReturnType<typeof createStepTaskDefinition>;

export function createStepTaskDefinition(options: StepTaskOptions) {
  const { executor } = options;
  const snapshot = (cwd: string): Promise<GitSnapshot> =>
    takeSnapshot(cwd, { ...(options.git === undefined ? {} : { git: options.git }) });

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
          const next: StepCheckpoint = {
            ...checkpoint,
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
          await runtime.commit(
            () => ({ status: "running", checkpoint: doneCheckpoint(checkpoint, status) }),
            context,
          );
        }
      },

      await: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
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
          // A transient poll error (daemon unreachable) behaves like "still running" and is
          // bounded by the deadline (spec: the step parks and retries with backoff). A terminal
          // executor failure becomes a step failure with its stable code.
          status =
            isArgosError(error) && error.code !== "paseo_unreachable"
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
        const base: CollectResult =
          checkpoint.status === undefined || checkpoint.status.state === "running"
            ? { ...(checkpoint.errorCode === undefined ? {} : { errorCode: checkpoint.errorCode }) }
            : {
                ...(checkpoint.status.outcome === undefined ? {} : { outcome: checkpoint.status.outcome }),
                ...(checkpoint.status.outputs === undefined ? {} : { outputs: checkpoint.status.outputs }),
                ...(checkpoint.status.errorCode === undefined ? {} : { errorCode: checkpoint.status.errorCode }),
                ...(checkpoint.status.usage === undefined ? {} : { usage: checkpoint.status.usage }),
                ...(checkpoint.status.feedback === undefined ? {} : { feedback: checkpoint.status.feedback }),
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
