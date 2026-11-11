/**
 * The durable host's ports and shared value types.
 *
 * `StepExecutor` is the whole seam between the durable task layer and whatever actually runs a
 * step (the fake in Phase 4, the Paseo adapter in Phase 6, scripts in Phase 7). The tasks never
 * import a client, a process, or a clock: everything comes through these interfaces, which is what
 * keeps the durability tests deterministic and the engine free of I/O.
 */

import type { ArgosErrorCode } from "../errors.js";
import type { OutputDefIR, Scalar } from "../playbook/ir.js";

// ------------------------------------------------------------------ clock

/**
 * The host clock. `now()` is used for every durable decision (timeouts, poll deadlines, event
 * times); `setTimer` arms the pi-durable scheduler. Tests inject a fake implementation and
 * advance it explicitly instead of sleeping.
 */
export interface Clock {
  now(): number;
  setTimer?(
    callback: () => void,
    delayMs: number,
    options: { readonly background: boolean },
  ): (() => void) | undefined;
}

/** The production clock: wall time plus `setTimeout`, exactly pi-durable's default. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** D3: gate wake poll (FR19). The gate task re-reads its decision document on every wake. */
export const GATE_POLL_MS = 2_000;

// ------------------------------------------------------------------ ids (D14)

/** `argos:<runId>:<stepId>:<attempt>` — stable across restarts, the launch idempotency key. */
export function stepRequestId(runId: string, stepId: string, attempt: number): string {
  return `argos:${runId}:${stepId}:${attempt}`;
}

/** The Paseo label set carried by every agent launch (Phase 6 reads it for reconciliation). */
export function launchLabel(runId: string, stepId: string, attempt: number): string {
  return `argos/run=${runId},argos/step=${stepId},argos/attempt=${attempt}`;
}

// ------------------------------------------------------------------ executor port

/** Everything the executor needs to create or adopt one agent launch. */
export interface StepAgentContext {
  /** Idempotency key: `argos:<runId>:<stepId>:<attempt>`. */
  readonly requestId: string;
  /** `argos/run=…,argos/step=…,argos/attempt=…` — the reconciliation label (Phase 6). */
  readonly label: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  /** Working directory: the run worktree when isolation is on, otherwise the run cwd. */
  readonly cwd: string;
  /** First resolved `provider/model` of the step (the preferred target). */
  readonly target?: string;
  /** Ordered candidates: preferred target first, then role/playbook fallbacks (FR24). */
  readonly targets?: readonly string[];
  /** Provider settings of the preferred target (`modeId`/`thinking`). */
  readonly agentConfig?: AgentStepConfig;
  readonly prompt?: string;
  /**
   * Feedback from the loop/gate that re-queued this step (`{{ feedback }}`). Also interpolated
   * into `prompt` by the run task, so an executor that reads only the prompt still sees it.
   */
  readonly feedback?: string;
  /** Outcome names declared by the step; an executor may compile them into a schema. */
  readonly outcomes: readonly string[];
  /** Output names declared by the step. */
  readonly outputs: readonly string[];
  /** Output definitions (type/enum/required/default) for the structured-result schema (D12). */
  readonly outputDefs: Readonly<Record<string, OutputDefIR>>;
  /** Targets the run already recorded as quota-exhausted, with their exhaustion time (FR24). */
  readonly exhausted?: readonly ExhaustedTarget[];
}

/** Provider settings for the preferred target. */
export interface AgentStepConfig {
  readonly provider: string;
  readonly model: string;
  readonly modeId?: string;
  readonly thinking?: string;
}

/** A `provider/model` skipped until `at + window` (mirrors the run record's `exhausted`). */
export interface ExhaustedTarget {
  readonly target: string;
  readonly at: number;
}

/** Launch input: the agent context plus the crash-reconciliation hint. */
export interface LaunchInput extends StepAgentContext {
  /**
   * True when an earlier `launch` invocation already marked "create attempted" in the
   * checkpoint. With an unsupported label filter that must fail `launch_uncertain` instead of
   * creating a possible duplicate (the crash window from FR16).
   */
  readonly priorCreateAttempt?: boolean;
}

/** The adopted or created agent. */
export interface AgentLaunch {
  readonly agentId: string;
  readonly target?: string;
  /** Targets discovered quota-exhausted during this launch (FR24). */
  readonly exhausted?: readonly ExhaustedTarget[];
}

/** Poll input: identify the agent that `launch` returned. */
export interface AgentStatusInput extends StepAgentContext {
  readonly agentId: string;
  /** True after the one allowed handover relaunch (agent archived mid-step). */
  readonly handoverAttempted?: boolean;
}

/** The provider's raw result, carried in the checkpoint so `collect` validates after a restart. */
export interface RawStepOutput {
  readonly output?: unknown;
  readonly text?: string | null;
  readonly provider?: string;
}

/**
 * What a status poll reports. `running` keeps the step task asleep for another `pollMs`; `done`
 * carries the engine-shaped result of the attempt. An `errorCode` on a `done` status is a step
 * failure, not a task failure: the run records it through `stepSettled`.
 *
 * `running` may carry a replacement `agentId` (the handover relaunch) plus `handover: true`, and
 * `exhausted` targets discovered while relaunching.
 */
export type StepAgentStatus =
  | {
      readonly state: "running";
      readonly agentId?: string;
      readonly target?: string;
      readonly handover?: boolean;
      readonly exhausted?: readonly ExhaustedTarget[];
    }
  | {
      readonly state: "done";
      readonly outcome?: string;
      readonly outputs?: Readonly<Record<string, Scalar>>;
      readonly errorCode?: ArgosErrorCode;
      readonly usage?: Readonly<Record<string, number>>;
      readonly feedback?: string;
      readonly exhausted?: readonly ExhaustedTarget[];
      /** Raw provider result; `collect` re-validates it with the step schema. */
      readonly raw?: RawStepOutput;
    };

/** Input of the optional final collection pass (structured-output parsing lives here in Phase 6). */
export interface CollectInput extends AgentStatusInput {
  readonly status: StepAgentStatus;
}

/** The refined result of a finished attempt. Collect may override the polled status. */
export interface CollectResult {
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, Scalar>>;
  readonly errorCode?: ArgosErrorCode;
  readonly usage?: Readonly<Record<string, number>>;
  readonly feedback?: string;
  readonly exhausted?: readonly ExhaustedTarget[];
}

/**
 * Launch, poll, and optionally collect one agent step.
 *
 * `launch` is **idempotent by `requestId`**: it must adopt an existing agent carrying the label
 * instead of creating a second one, because a crash can re-run the launch phase. `status` is a
 * pure read. `collect` is optional; when present it runs once per finished attempt and may
 * validate structured output.
 */
export interface StepExecutor {
  launch(input: LaunchInput): Promise<AgentLaunch>;
  status(input: AgentStatusInput): Promise<StepAgentStatus>;
  collect?(input: CollectInput): Promise<CollectResult>;
}

// ------------------------------------------------------------------ task results

/**
 * The `argos.step` task result consumed by `argos.run`. A step that fails is still a *completed*
 * task carrying an `errorCode`: task failure is reserved for a broken task, while a failed step is
 * an ordinary engine transition (`step_failed`, `step_timeout`, …).
 */
export interface StepTaskResult {
  readonly stepId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly outcome?: string;
  readonly outputs?: Readonly<Record<string, Scalar>>;
  readonly errorCode?: ArgosErrorCode;
  readonly agentId?: string;
  readonly target?: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly feedback?: string;
  /** Quota-exhausted targets observed by this attempt (merged into the run record, FR24). */
  readonly exhausted?: readonly ExhaustedTarget[];
  /**
   * Script steps only (FR22): the last exit code, how many times the script ran (exit-75 loops
   * included), and why the step failed. The run record keeps the stable `errorCode`; this is the
   * diagnostic detail the task receipt preserves (a terminal task cannot carry a checkpoint).
   */
  readonly exitCode?: number;
  readonly runs?: number;
  readonly detail?: string;
}

/** Terminal result of one `argos.run` task, mirroring the run's final status. */
export interface RunTaskResult {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly outcome?: string;
  readonly errorCode?: ArgosErrorCode;
}

/**
 * Terminal result of one `argos.gate` task: exactly what the run task needs to feed
 * `gateDecided` into the reducer.
 */
export interface GateTaskResult {
  readonly runId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt: number;
}

/** Link from an after-task run back to the run that started it (FR11). */
export interface AfterTaskLink {
  readonly parentRunId: string;
  readonly afterId: string;
}
