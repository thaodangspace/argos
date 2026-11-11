/**
 * `argos.gate` v1 — one child task per opened gate (FR19, D7).
 *
 * Phases: `await → decided`.
 *
 * - `await` reads the decision document (`argos.gate.<runId>.<gateId>`) and parks in
 *   `sleeping(until: now + GATE_POLL_MS)` while it is pending, so the wait costs no turn and no
 *   real timer, and a restart resumes the same poll with the same gate id (the id is the
 *   checkpoint's, never renumbered).
 * - `decided` commits a **terminal completed** task whose result is the decision. The run task
 *   maps that result to an engine `gateDecided` event; this task never touches the run record.
 *
 * The decision itself is written by `ArgosHost.decideGate` in one atomic commit (first writer
 * wins). A gate task is owned by its run task (`{kind:"task", taskId}`, D5), like step tasks.
 */

import { defineTask } from "@earendil-works/pi-durable";

import type { GateChoiceRecord, GateKind } from "../../engine/index.js";
import { GATE_POLL_MS, type GateTaskResult } from "../context.js";
import { gateKey, GateDocFamily } from "../mirror.js";

// ------------------------------------------------------------------ shape

export type GatePhase = "await" | "decided";

/**
 * Everything the task needs to seed and poll its document. `stepId`/`kind`/`edge` are carried for
 * the UI and for the run record's audit trail; only `runId` + `gateId` address the document.
 */
export interface GateTaskInput {
  readonly runId: string;
  readonly gateId: string;
  readonly stepId: string;
  readonly kind: GateKind;
  readonly edge?: string;
  readonly target?: string;
  readonly question: string;
  readonly choices: Readonly<Record<string, GateChoiceRecord>>;
  /** Creation time of the gate on the run record (the document's `createdAt`). */
  readonly createdAt: number;
}

export interface GateCheckpointFields {
  readonly gateId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: GateKind;
  readonly edge?: string;
  readonly question: string;
  readonly choices: Readonly<Record<string, GateChoiceRecord>>;
  /** Last poll time; proves the task is polling and helps `argos doctor`. */
  readonly seenAt: number;
  readonly decision?: string;
  readonly comment?: string;
  readonly decidedBy?: string;
  readonly decidedVia?: string;
  readonly decidedAt?: number;
}

/**
 * A discriminated union (not one interface with a union `phase`): pi-durable narrows each phase
 * handler's checkpoint with `Extract<S, { phase: P }>`, which only works on a real union.
 */
export type GateCheckpoint =
  | (GateCheckpointFields & { readonly phase: "await" })
  | (GateCheckpointFields & { readonly phase: "decided" });

// ------------------------------------------------------------------ definition

export function createGateTaskDefinition() {
  return defineTask<GateTaskInput, GateCheckpoint, GateTaskResult>({
    name: "argos.gate",
    version: 1,

    initial: (input): GateCheckpoint => ({
      phase: "await",
      gateId: input.gateId,
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      ...(input.edge === undefined ? {} : { edge: input.edge }),
      question: input.question,
      choices: input.choices,
      seenAt: input.createdAt,
    }),

    phases: {
      await: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const now = runtime.now();
        const document = await runtime.snapshot(
          GateDocFamily,
          gateKey(task.input.runId, task.input.gateId),
          context,
        );

        if (document !== undefined && document.status === "decided" && document.decision !== null) {
          const decided: GateCheckpoint = {
            ...checkpoint,
            phase: "decided",
            decision: document.decision,
            seenAt: now,
            ...(document.comment === null ? {} : { comment: document.comment }),
            ...(document.decidedBy === null ? {} : { decidedBy: document.decidedBy }),
            ...(document.decidedVia === null ? {} : { decidedVia: document.decidedVia }),
            decidedAt: document.decidedAt ?? now,
          };
          await runtime.commit(() => ({ status: "running", checkpoint: decided }), context);
          return;
        }

        const sleeping: GateCheckpoint = { ...checkpoint, seenAt: now };
        await runtime.commit(
          () => ({ status: "sleeping", until: now + GATE_POLL_MS, checkpoint: sleeping }),
          context,
        );
      },

      decided: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const decision = checkpoint.decision;
        if (decision === undefined) {
          // Defensive: never terminal-complete without a decision, and never abandon the gate.
          await runtime.commit(
            () => ({ status: "running", checkpoint: { ...checkpoint, phase: "await" } }),
            context,
          );
          return;
        }
        const result: GateTaskResult = {
          runId: checkpoint.runId,
          gateId: checkpoint.gateId,
          decision,
          decidedAt: checkpoint.decidedAt ?? runtime.now(),
          ...(checkpoint.comment === undefined ? {} : { comment: checkpoint.comment }),
          ...(checkpoint.decidedBy === undefined ? {} : { decidedBy: checkpoint.decidedBy }),
          ...(checkpoint.decidedVia === undefined ? {} : { decidedVia: checkpoint.decidedVia }),
        };
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        );
      },
    },

    abort: async (task, runtime, context) => {
      // Abort (run cancelled) carries no decision: the run task only consumes a *completed* gate
      // task, and a cancellation is already applied to the run through the reducer.
      void task;
      void runtime.now();
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
}

/** The task instance type, for the host's registry install. */
export type GateTaskDefinition = ReturnType<typeof createGateTaskDefinition>;
