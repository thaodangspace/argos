/**
 * Reducer output → next task state for `argos.run` (FR5.1 split of `tasks/run.ts`).
 *
 * `planNext` is the only place that turns an effect list into child tasks, mirror/history writes,
 * and the next durable state. It runs inside `runtime.commit()`, so the checkpoint, the run
 * document, and the history line always land in one transaction. Everything else here builds the
 * child input for one dispatch effect (`argos.step`, `argos.script`, or `argos.delay`) — the run
 * task never needs to know how a step does its work.
 */

import type { TaskId, Tx } from "@earendil-works/pi-durable";

import {
  isTerminalRunStatus,
  stepDefinition,
  stepTimeoutMs,
  type Effect,
  type ExhaustedRecord,
  type GateRecord,
  type RunRecord,
} from "../../engine/index.js";
import { resolveTimeoutValue } from "../../engine/timeouts.js";
import type { ProvidersIR } from "../../playbook/ir.js";
import {
  appendRunHistory,
  openGateDoc,
  skippedEffectDetail,
  writeRunState,
  type NewHistoryEvent,
} from "../mirror.js";

import type { DelayTaskDefinition, DelayTaskInput } from "./delay.js";
import type { GateTaskDefinition, GateTaskInput } from "./gate.js";
import type {
  GateSettlement,
  RunCheckpoint,
  RunFinished,
  StepSettlement,
} from "./run-checkpoint.js";
import { IDLE_POLL_MS } from "./run-checkpoint.js";
import { historyForEffects } from "./run-events.js";
import type { ScriptTaskDefinition, ScriptTaskInput } from "./script.js";
import type { StepTaskDefinition, StepTaskInput } from "./step.js";

/** Build one `argos.gate` child input from the run record's gate (D14 ids, never renumbered). */
export function gateInputFor(record: RunRecord, gate: GateRecord): GateTaskInput {
  return {
    runId: record.id,
    gateId: gate.id,
    stepId: gate.stepId,
    kind: gate.kind,
    ...(gate.edge === undefined ? {} : { edge: gate.edge }),
    ...(gate.target === undefined ? {} : { target: gate.target }),
    question: gate.question,
    choices: gate.choices,
    createdAt: gate.createdAt,
  };
}

/**
 * One dispatch decision: which child task kind a step needs and the input it is created with. A
 * `script` step gets an `argos.script` child (FR22), a `delay` step an `argos.delay` child; every
 * other non-gate step keeps the Phase 6 `argos.step` executor path.
 */
export type DispatchPlan =
  | { readonly kind: "step"; readonly input: StepTaskInput }
  | { readonly kind: "script"; readonly input: ScriptTaskInput }
  | { readonly kind: "delay"; readonly input: DelayTaskInput };

interface PlanContext {
  readonly runTaskId: TaskId;
  readonly checkpoint: RunCheckpoint;
  readonly stepTask: StepTaskDefinition;
  readonly scriptTask: ScriptTaskDefinition;
  readonly delayTask: DelayTaskDefinition;
  readonly gateTask: GateTaskDefinition;
  readonly dispatch: (effect: Extract<Effect, { type: "dispatchStep" }>) => DispatchPlan | undefined;
}

type PlannedState =
  | { readonly status: "running"; readonly checkpoint: RunCheckpoint }
  | { readonly status: "waiting"; readonly checkpoint: RunCheckpoint; readonly on: readonly TaskId[]; readonly policy: "allSettled" }
  | { readonly status: "sleeping"; readonly checkpoint: RunCheckpoint; readonly until: number };

/**
 * Turn the reducer's output into the next task state, creating child tasks and writing the
 * mirror/history in the same transaction. Called only from inside `runtime.commit()`.
 */
export async function planNext(
  tx: Tx,
  plan: PlanContext,
  record: RunRecord,
  effects: readonly Effect[],
  now: number,
  liveTaskIds: ReadonlySet<number>,
): Promise<PlannedState> {
  const previous = plan.checkpoint;
  const childTasks: Record<string, TaskId> = { ...previous.childTasks };
  const dispatched: Record<string, string> = { ...previous.dispatched };
  const gateTasks: Record<string, TaskId> = {};
  const afterTasks: Record<string, TaskId> = { ...previous.afterTasks };
  const waiting = new Set<TaskId>();
  let finished: RunFinished | undefined = previous.finished;
  let wakeAt: number | undefined;
  const recorded: NewHistoryEvent[] = [];

  // Reconcile the gate children recorded by earlier phases. A pending gate whose child is gone
  // (or broke) is dropped so the `gate` phase opens a fresh one; a decided gate keeps its task id
  // for auditability. Re-opening never renumbers the gate id (D14).
  for (const [gateId, taskId] of Object.entries(previous.gateTasks)) {
    const gate = record.gates.find((candidate) => candidate.id === gateId);
    if (gate === undefined) continue;
    if (liveTaskIds.has(Number(taskId))) {
      gateTasks[gateId] = taskId;
      waiting.add(taskId);
      continue;
    }
    if (gate.status === "decided") gateTasks[gateId] = taskId;
  }

  for (const effect of effects) {
    switch (effect.type) {
      case "dispatchStep": {
        const planned = plan.dispatch(effect);
        if (planned === undefined) {
          recorded.push({
            type: "effect_skipped",
            stepId: effect.stepId,
            attempt: effect.attempt,
            detail: skippedEffectDetail("dispatchStep", "step definition missing from the frozen IR"),
          });
          break;
        }
        const ownership = { kind: "task", taskId: plan.runTaskId } as const;
        const childId =
          planned.kind === "script"
            ? await tx.createTask(plan.scriptTask, planned.input, { ownership })
            : planned.kind === "delay"
              ? await tx.createTask(plan.delayTask, planned.input, { ownership })
              : await tx.createTask(plan.stepTask, planned.input, { ownership });
        childTasks[effect.stepId] = childId;
        dispatched[String(childId)] = effect.stepId;
        waiting.add(childId);
        break;
      }
      case "openGate": {
        if (gateTasks[effect.gateId] !== undefined) break; // already open (idempotent)
        const gate = record.gates.find((candidate) => candidate.id === effect.gateId);
        if (gate === undefined) {
          recorded.push({
            type: "effect_skipped",
            stepId: effect.stepId,
            detail: skippedEffectDetail("openGate", `gate ${effect.gateId} missing from the run record`),
          });
          break;
        }
        const childId = await tx.createTask(plan.gateTask, gateInputFor(record, gate), {
          ownership: { kind: "task", taskId: plan.runTaskId },
        });
        await openGateDoc(tx, record.id, gate);
        gateTasks[gate.id] = childId;
        waiting.add(childId);
        break;
      }
      case "finishRun": {
        finished = {
          status: effect.status,
          ...(effect.outcome === undefined ? {} : { outcome: effect.outcome }),
          ...(effect.errorCode === undefined ? {} : { errorCode: effect.errorCode }),
        };
        break;
      }
      case "startAfterTask": {
        // Executed by the `done` phase, which creates one `argos.run` child per auto after-task.
        recorded.push({ type: "after_queued", detail: effect.id });
        break;
      }
      case "decisionRejected": {
        recorded.push({
          type: "effect_skipped",
          detail: skippedEffectDetail("decisionRejected", `${effect.code} on gate ${effect.gateId}`),
        });
        break;
      }
      case "scheduleWake": {
        wakeAt = wakeAt === undefined ? effect.at : Math.min(wakeAt, effect.at);
        break;
      }
    }
  }

  for (const taskId of Object.keys(dispatched)) {
    const id = Number(taskId);
    if (Number.isInteger(id) && liveTaskIds.has(id)) waiting.add(id as TaskId);
  }

  if (finished === undefined && isTerminalRunStatus(record.status)) {
    const status: RunFinished["status"] =
      record.status === "completed" || record.status === "cancelled" ? record.status : "failed";
    finished = {
      status,
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    };
  }

  const base = {
    record,
    childTasks,
    dispatched,
    awaiting: [] as readonly TaskId[],
    settles: [] as readonly StepSettlement[],
    gateTasks,
    gateSettles: [] as readonly GateSettlement[],
    afterTasks,
    ...(previous.lastClientRequestId === undefined
      ? {}
      : { lastClientRequestId: previous.lastClientRequestId }),
    ...(finished === undefined ? {} : { finished }),
  };

  await writeRunState(tx, plan.runTaskId, record, historyForEffects(effects));
  for (const event of recorded) {
    // Same commit: the skip/queue record lands with the checkpoint it describes.
    await appendRunHistory(tx, record.id, record, event);
  }

  if (finished !== undefined) {
    return { status: "running", checkpoint: { ...base, phase: "done" } };
  }

  if (waiting.size > 0) {
    const on = [...waiting];
    return {
      status: "waiting",
      on,
      policy: "allSettled",
      checkpoint: { ...base, phase: "await", awaiting: on, settles: [] },
    };
  }

  // A gate is pending with no child task: the `gate` phase opens one (a restart never renumbers).
  if (record.gates.some((gate) => gate.status === "pending" && gateTasks[gate.id] === undefined)) {
    return { status: "running", checkpoint: { ...base, phase: "gate" } };
  }

  // Nothing is live and nothing is gated: poll. This is the retry-backoff path (the engine set
  // `notBefore`) and a safety net for an unexpected empty ready set.
  return {
    status: "sleeping",
    until: wakeAt === undefined ? now + IDLE_POLL_MS : Math.min(wakeAt, now + IDLE_POLL_MS),
    checkpoint: { ...base, phase: "select" },
  };
}

/**
 * Render `{{ feedback }}` into a prompt. Feedback is the only template variable the run task
 * interpolates (the rest is Phase 6): a gate comment or a loop's feedback text must reach the next
 * attempt's prompt (FR15).
 */
export function renderFeedback(prompt: string, feedback: string | undefined): string {
  if (feedback === undefined) return prompt;
  return prompt.replace(/\{\{\s*feedback\s*\}\}/g, feedback);
}

/** Build the `argos.step` child input from the frozen step definition. */
function stepInputFor(record: RunRecord, effect: Extract<Effect, { type: "dispatchStep" }>): StepTaskInput | undefined {
  const definition = stepDefinition(record, effect.stepId);
  if (definition === undefined) return undefined;
  const agent = definition.agent;
  const target = agent === undefined ? undefined : `${agent.provider}/${agent.model}`;
  const targets = [
    ...(target === undefined ? [] : [target]),
    ...(definition.fallbacks ?? []).map((fallback) => `${fallback.provider}/${fallback.model}`),
  ];
  const uniqueTargets = [...new Set(targets)];
  const feedback = record.steps[definition.id]?.feedback;
  const prompt =
    definition.prompt === undefined ? undefined : renderFeedback(definition.prompt, feedback);
  return {
    runId: record.id,
    stepId: definition.id,
    attempt: effect.attempt,
    requestId: effect.requestId,
    cwd: record.worktree?.path ?? record.cwd,
    pollMs: definition.pollMs,
    timeoutMs: stepTimeoutMs(definition, record.inputs),
    retries: definition.retries,
    outcomes: definition.outcomes,
    outputs: Object.keys(definition.outputs),
    outputDefs: definition.outputs,
    ...(uniqueTargets.length === 0 ? {} : { targets: uniqueTargets }),
    ...(agent === undefined
      ? {}
      : {
          agentConfig: {
            provider: agent.provider,
            model: agent.model,
            ...(agent.modeId === undefined ? {} : { modeId: agent.modeId }),
            ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
          },
        }),
    ...(record.exhausted.length === 0 ? {} : { exhausted: record.exhausted }),
    ...(target === undefined ? {} : { target }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(feedback === undefined ? {} : { feedback }),
    // D8: a read-only role makes the step task snapshot the tree before launch and compare after.
    ...(definition.role?.readonly === true ? { readonly: true } : {}),
    ...providerPolicy(record.ir.providers),
  };
}

/** FR24: the playbook's quota policy, copied onto each agent step task. */
function providerPolicy(
  providers: ProvidersIR | undefined,
): Pick<StepTaskInput, "quotaWindowMs" | "onExhausted" | "maxQuotaWaitMs"> {
  if (providers === undefined) return {};
  return {
    onExhausted: providers.onExhausted,
    ...(providers.exhaustedForMs === undefined ? {} : { quotaWindowMs: providers.exhaustedForMs }),
    ...(providers.maxWaitMs === undefined ? {} : { maxQuotaWaitMs: providers.maxWaitMs }),
  };
}

/**
 * Build the `argos.script` child input (FR22). `cwd` is where the executable runs (the run
 * worktree when isolated); `scriptRoot` is where `.argos/scripts` is resolved from, so a local
 * uncommitted helper can drive an isolated run while still working on the private checkout.
 */
function scriptInputFor(
  record: RunRecord,
  effect: Extract<Effect, { type: "dispatchStep" }>,
  home: string | undefined,
): ScriptTaskInput | undefined {
  const definition = stepDefinition(record, effect.stepId);
  const script = definition?.script;
  if (definition === undefined || script === undefined) return undefined;
  // FR3: the pin the run recorded at start; absent on a pre-pinning record (FR3.6).
  const pin = record.scripts?.[script.run];
  return {
    runId: record.id,
    stepId: definition.id,
    attempt: effect.attempt,
    requestId: effect.requestId,
    cwd: record.worktree?.path ?? record.cwd,
    scriptRoot: record.cwd,
    ...(home === undefined ? {} : { scriptHome: home }),
    script: script.run,
    ...(pin === undefined ? {} : { pin }),
    env: script.env,
    pollMs: definition.pollMs,
    timeoutMs: stepTimeoutMs(definition, record.inputs),
    outputs: Object.keys(definition.outputs),
    outcomes: definition.outcomes,
    ...(definition.role?.readonly === true ? { readonly: true } : {}),
  };
}

/**
 * Build the `argos.delay` child input. The duration is resolved here, against the run inputs, so a
 * `{{ inputs.x }}` delay is fixed at dispatch; the task turns it into an absolute wake time once.
 */
function delayInputFor(
  record: RunRecord,
  effect: Extract<Effect, { type: "dispatchStep" }>,
): DelayTaskInput | undefined {
  const definition = stepDefinition(record, effect.stepId);
  if (definition?.delay === undefined) return undefined;
  const delayMs = resolveTimeoutValue(definition.delay, record.inputs);
  return {
    runId: record.id,
    stepId: definition.id,
    attempt: effect.attempt,
    requestId: effect.requestId,
    delay: definition.delay,
    ...(delayMs === undefined ? {} : { delayMs }),
    outcomes: definition.outcomes,
  };
}

/** Choose the child task kind for one dispatch effect (`script`/`delay` never reach the executor). */
export function dispatchPlanFor(
  record: RunRecord,
  effect: Extract<Effect, { type: "dispatchStep" }>,
  home: string | undefined,
): DispatchPlan | undefined {
  const definition = stepDefinition(record, effect.stepId);
  if (definition === undefined) return undefined;
  if (definition.kind === "script") {
    const input = scriptInputFor(record, effect, home);
    return input === undefined ? undefined : { kind: "script", input };
  }
  if (definition.kind === "delay") {
    const input = delayInputFor(record, effect);
    return input === undefined ? undefined : { kind: "delay", input };
  }
  const input = stepInputFor(record, effect);
  return input === undefined ? undefined : { kind: "step", input };
}

/**
 * Merge a settlement's quota-exhausted targets into the run record (FR24). One entry per target,
 * latest `at`, stable order; the record (and its `seq`) only changes when an entry actually moves.
 */
export function mergeExhausted(
  current: readonly ExhaustedRecord[],
  incoming: readonly ExhaustedRecord[],
): readonly ExhaustedRecord[] {
  if (incoming.length === 0) return current;
  const merged = new Map<string, number>();
  for (const entry of current) merged.set(entry.target, entry.at);
  let changed = false;
  for (const entry of incoming) {
    const previous = merged.get(entry.target);
    if (previous === undefined || entry.at > previous) {
      merged.set(entry.target, entry.at);
      changed = true;
    }
  }
  if (!changed) return current;
  return [...merged.entries()].map(([target, at]) => ({ target, at }));
}
