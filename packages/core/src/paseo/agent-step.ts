/**
 * The Paseo `StepExecutor` (Phase 6): FR16, FR17, FR24, D11, D12.
 *
 * `argos.step` consumes this through the Phase 4 `StepExecutor` port, so the durable layer never
 * imports a Paseo client and every test uses the fake port from `test/fakes/paseo.ts`.
 *
 * Behaviour, in the order a step experiences it:
 *
 * 1. **launch** — adopt by `argos/launch` label (the crash reconcile point), otherwise create.
 *    If the daemon cannot filter labels and a previous invocation already attempted a create,
 *    fail `launch_uncertain` instead of blind-relaunching. Quota errors move to the next ordered
 *    target without consuming `retries` (FR24).
 * 2. **status** — `refresh()`; an archived/unknown agent gets exactly one handover relaunch, a
 *    second occurrence fails `agent_missing`. `waitForFinish` timeouts park the step (the durable
 *    deadline owns retries). A finished agent's result is validated against the compiled schema.
 * 3. **collect** — re-validates the raw provider result from the checkpoint, so a restarted step
 *    that never re-enters `launch` still reports `invalid_output` rather than silently passing.
 *
 * No LLM ever decides control flow: outcomes are validated against the step's declared enum and
 * the engine routes them.
 */

import { ArgosError } from "../errors.js";
import type {
  AgentLaunch,
  AgentStatusInput,
  AgentStepConfig,
  CollectInput,
  CollectResult,
  ExhaustedTarget,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../durable/context.js";
import { DEFAULT_EXHAUSTED_WINDOW_MS } from "./model-catalog.js";
import {
  buildStepOutputSchema,
  parseStepResult,
  type RawStepResult,
  type StepOutputSchema,
} from "./output.js";
import {
  AgentMissingError,
  classifyPaseoFailure,
  isAgentMissing,
  isConnectionError,
  isLabelFilterUnsupported,
  isQuotaError,
  isQuotaNotice,
  LabelFilterUnsupportedError,
  PaseoUnreachableError,
  ProviderTimeoutError,
  type AgentInfo,
  type AgentRef,
  type CreateAgentInput,
  type FinishResult,
  type PaseoPort,
} from "./port.js";

/** The catalog subset the adapter needs. `ModelCatalog` implements it. */
export interface AgentTargetCatalog {
  has(target: string): boolean;
}

export interface AgentStepExecutorOptions {
  readonly port: PaseoPort;
  /** Optional catalog: candidates absent from it are never launched (`model_unavailable`). */
  readonly catalog?: AgentTargetCatalog;
  /** Injected clock for exhaustion windows (tests use a fake clock). */
  readonly now?: () => number;
  /** How long a quota-exhausted target is skipped (default 15 min, FR24). */
  readonly quotaWindowMs?: number;
  /** Extra instruction appended to the prompt of a handover relaunch. */
  readonly handoverNote?: string;
}

/**
 * Every ordered target is inside its quota window. Carries the ledger so the run record can
 * record `exhausted: [{target, at}]` even when the attempt never launched (FR24).
 */
export class ProviderExhaustedError extends ArgosError {
  readonly exhausted: readonly ExhaustedTarget[];

  constructor(targets: readonly string[], exhausted: readonly ExhaustedTarget[]) {
    super(
      "provider_exhausted",
      `all provider targets are quota-exhausted: ${targets.join(", ")}`,
    );
    this.name = "ProviderExhaustedError";
    this.exhausted = exhausted;
  }
}

const DEFAULT_HANDOVER_NOTE =
  "Your previous agent session was archived mid-step. A new session has been started for you. " +
  "Continue the same task from the current workspace state; do not restart work that is already done.";

/** Render the only template variable the adapter owns (`{{ feedback }}`). */
function renderFeedback(prompt: string, feedback: string | undefined): string {
  if (feedback === undefined) return prompt;
  return prompt.replace(/\{\{\s*feedback\s*\}\}/g, feedback);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stable Argos code for a port-level throw (never leaks an SDK detail). */
function toArgosError(error: unknown, target: string | undefined): ArgosError {
  if (error instanceof ArgosError) return error;
  const classified = classifyPaseoFailure(error);
  const message = classified instanceof Error ? classified.message : String(classified);
  if (classified instanceof PaseoUnreachableError) {
    return new ArgosError("paseo_unreachable", message);
  }
  if (classified instanceof LabelFilterUnsupportedError) {
    return new ArgosError("launch_uncertain", message);
  }
  if (classified instanceof AgentMissingError) {
    return new ArgosError("agent_missing", message);
  }
  return new ArgosError(
    "step_failed",
    `${target ?? "agent"}: ${message}`,
    classified instanceof Error ? { cause: classified } : {},
  );
}

export function createAgentStepExecutor(options: AgentStepExecutorOptions): StepExecutor {
  const { port } = options;
  const now = options.now ?? (() => Date.now());
  const quotaWindowMs = options.quotaWindowMs ?? DEFAULT_EXHAUSTED_WINDOW_MS;
  const handoverNote = options.handoverNote ?? DEFAULT_HANDOVER_NOTE;
  /** In-memory quota ledger, seeded by the run record's `exhausted` on every call (FR24). */
  const exhaustedAt = new Map<string, number>();

  /** The ordered, catalog-filtered candidates of a step. */
  function candidatesOf(input: LaunchInput | AgentStatusInput): string[] {
    const ordered = [
      ...(input.target === undefined ? [] : [input.target]),
      ...(input.targets ?? []),
    ];
    const unique = [...new Set(ordered)];
    const known =
      options.catalog === undefined ? unique : unique.filter((target) => options.catalog?.has(target) === true);
    if (known.length === 0) {
      throw new ArgosError(
        "model_unavailable",
        unique.length === 0
          ? `step ${input.stepId}: no provider/model resolved for this agent step`
          : `step ${input.stepId}: none of ${unique.join(", ")} is present in providers.snapshot()`,
      );
    }
    return known;
  }

  function blockedAt(
    target: string,
    persisted: readonly ExhaustedTarget[] | undefined,
    at: number,
    windowMs: number,
  ): number | undefined {
    const candidates: number[] = [];
    const memory = exhaustedAt.get(target);
    if (memory !== undefined) candidates.push(memory);
    const recorded = persisted?.find((entry) => entry.target === target)?.at;
    if (recorded !== undefined) candidates.push(recorded);
    if (candidates.length === 0) return undefined;
    const since = Math.max(...candidates);
    return at >= since && at - since < windowMs ? since : undefined;
  }

  function agentConfigFor(input: LaunchInput | AgentStatusInput, target: string): AgentStepConfig {
    const preferred = input.agentConfig;
    if (
      preferred !== undefined &&
      `${preferred.provider}/${preferred.model}` === target
    ) {
      return preferred;
    }
    const slash = target.indexOf("/");
    const provider = slash < 0 ? target : target.slice(0, slash);
    const model = slash < 0 ? "" : target.slice(slash + 1);
    return { provider, model };
  }

  function createInput(
    input: LaunchInput | AgentStatusInput,
    target: string,
    handover: boolean,
  ): CreateAgentInput {
    const compiled = buildStepOutputSchema({
      outputs: input.outputDefs,
      outcomes: input.outcomes,
    });
    const config = agentConfigFor(input, target);
    const basePrompt = renderFeedback(input.prompt ?? "", input.feedback);
    const prompt =
      handover && basePrompt.length > 0
        ? `${basePrompt}\n\n${handoverNote}`
        : handover
          ? handoverNote
          : basePrompt;
    const labels: Record<string, string> = {
      "argos/launch": input.requestId,
      "argos/run": input.runId,
      "argos/step": input.stepId,
      "argos/attempt": String(input.attempt),
    };
    if (handover) labels["argos/handover"] = "1";
    return {
      requestId: input.requestId,
      config: {
        provider: target,
        ...(config.modeId === undefined ? {} : { modeId: config.modeId }),
        ...(config.thinking === undefined ? {} : { thinkingOptionId: config.thinking }),
      },
      cwd: input.cwd,
      ...(prompt.length === 0 ? {} : { prompt }),
      labels,
      ...(compiled.hasSchema ? { outputSchema: compiled.schema } : {}),
    };
  }

  /** Create across the ordered candidates, skipping quota-exhausted targets (FR24). */
  async function createWithFallback(
    input: LaunchInput | AgentStatusInput,
    handover: boolean,
  ): Promise<AgentLaunch> {
    const at = now();
    const candidates = candidatesOf(input);
    const windowMs = input.quotaWindowMs ?? quotaWindowMs;
    const exhausted: ExhaustedTarget[] = [];
    const available: string[] = [];
    for (const target of candidates) {
      const since = blockedAt(target, input.exhausted, at, windowMs);
      if (since === undefined) available.push(target);
      else exhausted.push({ target, at: since });
    }
    if (available.length === 0) throw new ProviderExhaustedError(candidates, exhausted);

    for (const target of available) {
      try {
        const ref = await port.create(createInput(input, target, handover));
        return {
          agentId: ref.agentId,
          target: ref.target ?? target,
          ...(exhausted.length === 0 ? {} : { exhausted }),
        };
      } catch (error) {
        if (isQuotaError(error)) {
          // A quota error never consumes a retry: the same attempt moves to the next target.
          exhaustedAt.set(target, at);
          exhausted.push({ target, at });
          continue;
        }
        throw toArgosError(error, target);
      }
    }
    throw new ProviderExhaustedError(candidates, exhausted);
  }

  /** Adopt by label when possible; refuse a blind relaunch in the crash window (FR16). */
  async function launch(input: LaunchInput): Promise<AgentLaunch> {
    let labelUnsupported = port.supportsLabelFilter !== true;
    let found: AgentRef | undefined;
    if (!labelUnsupported) {
      try {
        const refs = await port.listByLabels({ "argos/launch": input.requestId });
        found = refs.find((ref) => ref.archived !== true) ?? refs[0];
      } catch (error) {
        if (isLabelFilterUnsupported(error)) {
          labelUnsupported = true;
        } else {
          throw toArgosError(error, input.target);
        }
      }
    }

    if (labelUnsupported && input.priorCreateAttempt === true) {
      throw new ArgosError(
        "launch_uncertain",
        `step ${input.stepId} attempt ${input.attempt}: the daemon cannot filter by label and a create may already have happened (request ${input.requestId}); reconcile the agent manually instead of risking a duplicate`,
      );
    }
    if (found !== undefined) {
      return {
        agentId: found.agentId,
        ...(found.target === undefined ? {} : { target: found.target }),
      };
    }
    return createWithFallback(input, false);
  }

  /** The validated result, or `null` when the turn ended on a usage-limit notice (FR24). */
  function validateFinish(
    input: AgentStatusInput,
    finish: FinishResult,
    info: AgentInfo,
  ): StepAgentStatus | null {
    const compiled: StepOutputSchema = buildStepOutputSchema({
      outputs: input.outputDefs,
      outcomes: input.outcomes,
    });
    const output = finish.output ?? info.output;
    const text = finish.lastMessage ?? info.lastMessage ?? null;
    const raw: RawStepResult = {
      ...(output === undefined ? {} : { output }),
      text,
      ...(input.target === undefined ? {} : { provider: input.target }),
    };
    const validation = parseStepResult(compiled, raw);
    const usage = finish.usage ?? info.usage;
    const rawField = { raw };
    if (!validation.ok && output === undefined && isQuotaNotice(text)) return null;
    if (!validation.ok) {
      return {
        state: "done",
        errorCode: "invalid_output",
        feedback: validation.error,
        ...rawField,
        ...(usage === undefined ? {} : { usage }),
      };
    }
    return {
      state: "done",
      outputs: validation.outputs,
      ...(validation.outcome === undefined ? {} : { outcome: validation.outcome }),
      ...rawField,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** One handover relaunch, then `agent_missing` (edge case: agent archived mid-step). */
  async function handover(input: AgentStatusInput): Promise<StepAgentStatus> {
    if (input.handoverAttempted === true) {
      return {
        state: "done",
        errorCode: "agent_missing",
        feedback: `agent ${input.agentId} is unknown or archived after one handover relaunch`,
      };
    }
    try {
      await port.archive(input.agentId);
    } catch {
      // Best effort: an already-archived agent is exactly the case we are recovering from.
    }
    const created = await createWithFallback(input, true);
    return {
      state: "running",
      agentId: created.agentId,
      handover: true,
      ...(created.target === undefined ? {} : { target: created.target }),
      ...(created.exhausted === undefined ? {} : { exhausted: created.exhausted }),
    };
  }

  /**
   * The running agent hit a usage limit (an error or a bare notice as its final message). Record
   * the target as exhausted and relaunch the same attempt on the next available candidate, like a
   * launch-time quota error (FR24). When every candidate is blocked the step reports
   * `provider_exhausted` with the ledger, and the step task decides whether to wait or fail.
   */
  async function quotaRelaunch(input: AgentStatusInput, detail: string | undefined): Promise<StepAgentStatus> {
    const at = now();
    const target = input.target;
    const hit: ExhaustedTarget[] = target === undefined ? [] : [{ target, at }];
    if (target !== undefined) exhaustedAt.set(target, at);
    try {
      await port.archive(input.agentId);
    } catch {
      // Best effort: the archived agent only keeps its launch label from being adopted again.
    }
    const withHit = (entries: readonly ExhaustedTarget[]): ExhaustedTarget[] => [
      ...hit,
      ...entries.filter((entry) => entry.target !== target),
    ];
    const ledger = withHit(input.exhausted ?? []);
    try {
      const created = await createWithFallback({ ...input, exhausted: ledger }, true);
      return {
        state: "running",
        agentId: created.agentId,
        ...(created.target === undefined ? {} : { target: created.target }),
        exhausted: withHit(created.exhausted ?? []),
      };
    } catch (error) {
      if (error instanceof ProviderExhaustedError) {
        return {
          state: "done",
          errorCode: "provider_exhausted",
          feedback: detail === undefined ? error.message : `${error.message}: ${detail}`,
          exhausted: withHit(error.exhausted),
        };
      }
      throw error;
    }
  }

  return {
    launch,

    async status(input: AgentStatusInput): Promise<StepAgentStatus> {
      let info: AgentInfo | null;
      try {
        info = await port.refresh(input.agentId);
      } catch (error) {
        if (isAgentMissing(error)) return handover(input);
        if (isConnectionError(error)) {
          // Transient: park the step; the durable deadline bounds the wait and owns retries.
          return { state: "running" };
        }
        if (isQuotaError(error)) return quotaRelaunch(input, errorMessage(error));
        throw toArgosError(error, input.target);
      }

      if (info === null || info.archived === true || info.status === "closed") {
        return handover(input);
      }
      if (
        info.status === "running" ||
        info.status === "initializing" ||
        info.status === "permission"
      ) {
        return { state: "running" };
      }
      if (info.status === "error") {
        if (isQuotaNotice(info.error)) return quotaRelaunch(input, info.error ?? undefined);
        return {
          state: "done",
          errorCode: "step_failed",
          ...(info.error === null || info.error === undefined ? {} : { feedback: info.error }),
        };
      }

      // Idle: collect the turn's final result. A timeout here is not an agent failure; the step
      // deadline decides whether to retry (D11/FR18).
      let finish: FinishResult;
      try {
        finish = await port.waitForFinish(input.agentId, 0);
      } catch (error) {
        if (error instanceof ProviderTimeoutError) return { state: "running" };
        if (isAgentMissing(error)) return handover(input);
        if (isConnectionError(error)) return { state: "running" };
        throw toArgosError(error, input.target);
      }
      if (finish.status === "timeout" || finish.status === "permission") {
        return { state: "running" };
      }
      if (finish.status === "error") {
        if (isQuotaNotice(finish.error)) return quotaRelaunch(input, finish.error ?? undefined);
        return {
          state: "done",
          errorCode: "step_failed",
          ...(finish.error === null || finish.error === undefined ? {} : { feedback: finish.error }),
        };
      }
      const validated = validateFinish(input, finish, info);
      if (validated !== null) return validated;
      return quotaRelaunch(input, (finish.lastMessage ?? info.lastMessage ?? "").trim() || undefined);
    },

    /**
     * Re-validate the raw result carried in the checkpoint. `status` already validated it to
     * decide whether to retry `invalid_output`; doing it again here keeps the terminal result
     * authoritative after a restart (the executor may never see `launch` again).
     */
    async collect(input: CollectInput): Promise<CollectResult> {
      const status = input.status;
      if (status.state !== "done") return {};
      if (status.raw === undefined) {
        return {
          ...(status.outcome === undefined ? {} : { outcome: status.outcome }),
          ...(status.outputs === undefined ? {} : { outputs: status.outputs }),
          ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
          ...(status.usage === undefined ? {} : { usage: status.usage }),
          ...(status.feedback === undefined ? {} : { feedback: status.feedback }),
          ...(status.exhausted === undefined ? {} : { exhausted: status.exhausted }),
        };
      }
      const compiled = buildStepOutputSchema({
        outputs: input.outputDefs,
        outcomes: input.outcomes,
      });
      const validation = parseStepResult(compiled, status.raw);
      if (!validation.ok) {
        return {
          errorCode: "invalid_output",
          feedback: validation.error,
          ...(status.exhausted === undefined ? {} : { exhausted: status.exhausted }),
        };
      }
      return {
        outputs: validation.outputs,
        ...(validation.outcome === undefined ? {} : { outcome: validation.outcome }),
        ...(status.usage === undefined ? {} : { usage: status.usage }),
        ...(status.exhausted === undefined ? {} : { exhausted: status.exhausted }),
      };
    },
  };
}
