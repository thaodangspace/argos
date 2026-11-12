/**
 * After-task spawning (FR11, D4).
 *
 * An `after` entry of a playbook runs as a **separate `argos.run` task** with its own frozen
 * `PlaybookIR` containing only that entry's steps. The parent run's `after[id]` state is
 * bookkeeping only: an after-task never changes the parent's `run.status` (the reducer already
 * moved the parent to `completed`/`failed` before the child is created).
 *
 * - `trigger: "auto"` children are created by the parent run task's `done` phase, owned by the
 *   parent task (`{kind:"task", taskId}`, D5), in the same commit that commits the parent's
 *   terminal outcome.
 * - `trigger: "manual"` children are created by `ArgosHost.startAfterTask` once the run is
 *   terminal. They are conversation-owned because pi-durable refuses a child of a terminal owner
 *   ("Task owner N is terminal"); the `after` link in the child's input carries the parent.
 *
 * The after-task's child run id is a fresh ULID and its record is a normal `RunRecord`, so its
 * steps go through the same `argos.step`/`argos.gate` machinery as any other run.
 */

import type {
  ConversationId,
  Task,
  TaskId,
  TaskOwnership,
  Tx,
} from "@earendil-works/pi-durable";

import type { AfterIR, PlaybookIR } from "../../playbook/ir.js";
import { deepFreeze } from "../../playbook/ir.js";
import { playbookHash } from "../../playbook/hash.js";
import { createRunRecord, type RunRecord } from "../../engine/index.js";
import type { AfterTaskLink, RunTaskResult } from "../context.js";
import { registerRun, writeRunState, type NewHistoryEvent } from "../mirror.js";
import { ulid } from "../ulid.js";
import type { RunCheckpoint, RunTaskInput } from "./run-checkpoint.js";

/**
 * The scoped IR of one after-task: the entry's steps only, with a content hash of its own (the
 * run record's `playbookHash === ir.hash` invariant is checked by `hydrateRunRecord`). Inputs,
 * labels, and roles are inherited so `{{ playbook.inputs.x }}` and role lookups keep working.
 */
export function afterPlaybookIR(parent: RunRecord, after: AfterIR): PlaybookIR {
  const base = {
    version: 1 as const,
    id: `${parent.playbookId}/${after.id}`,
    title: after.title,
    description: `after-task "${after.id}" of playbook "${parent.playbookId}"`,
    hash: "",
    inputs: parent.ir.inputs,
    outputs: {},
    ...(parent.ir.concurrency === undefined ? {} : { concurrency: parent.ir.concurrency }),
    steps: after.steps,
    outcomes: [] as readonly string[],
    blocks: {},
    after: [] as readonly AfterIR[],
    labels: parent.ir.labels,
    roles: parent.ir.roles,
  };
  return deepFreeze({ ...base, hash: playbookHash(base) }) as PlaybookIR;
}

export interface PlannedAfterRun {
  readonly afterId: string;
  readonly link: AfterTaskLink;
  readonly record: RunRecord;
}

/** Build the child run of one `after` entry, ready for `tx.createTask`. */
export function planAfterRun(parent: RunRecord, after: AfterIR, now: number): PlannedAfterRun {
  const runId = ulid(now);
  const record = createRunRecord({
    id: runId,
    ir: afterPlaybookIR(parent, after),
    inputs: parent.inputs,
    cwd: parent.cwd,
    now,
    ...(parent.worktree === undefined ? {} : { worktree: parent.worktree }),
    // FR3.5: an after-task runs the same pinned scripts as the run that spawned it, so a script
    // fixed in the parent's worktree cannot slip into an after-task unnoticed.
    ...(parent.scripts === undefined ? {} : { scripts: parent.scripts }),
  });
  return {
    afterId: after.id,
    link: { parentRunId: parent.id, afterId: after.id },
    record,
  };
}

/**
 * `after` entries whose child must be created now: `auto` entries the reducer already moved to
 * `running` and that have no child task yet. A manual entry is never started here (FR11).
 */
export function plannedAfterTasks(checkpoint: RunCheckpoint, now: number): PlannedAfterRun[] {
  const planned: PlannedAfterRun[] = [];
  for (const after of checkpoint.record.ir.after) {
    if (after.trigger !== "auto") continue;
    if (checkpoint.afterTasks[after.id] !== undefined) continue;
    const state = checkpoint.record.after[after.id];
    if (state === undefined || state.status !== "running") continue;
    planned.push(planAfterRun(checkpoint.record, after, now));
  }
  return planned;
}

/**
 * Start one `argos.run` child as an after-task (FR11). Shared by the `done` phase (auto) and
 * `ArgosHost.startAfterTask` (manual) so both write the child mirror identically.
 */
export async function createAfterRunTask(
  tx: Tx,
  runTask: Task<RunTaskInput, RunCheckpoint, RunTaskResult, object>,
  planned: PlannedAfterRun,
  options: {
    readonly ownership: TaskOwnership;
    /** Required for a conversation-owned child created outside a task commit. */
    readonly conversationId?: ConversationId;
    readonly history?: NewHistoryEvent;
  },
): Promise<TaskId> {
  const childId = await tx.createTask(
    runTask,
    { runId: planned.record.id, record: planned.record, after: planned.link },
    {
      ownership: options.ownership,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    },
  );
  await writeRunState(tx, childId, planned.record, options.history ?? {
    type: "run_started",
    detail: planned.afterId,
  });
  await registerRun(tx, planned.record.id);
  return childId;
}
