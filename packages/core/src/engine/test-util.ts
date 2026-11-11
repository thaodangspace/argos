/**
 * Test-only helpers for the pure engine. Excluded from the build (see `tsconfig.json`), so it
 * never ships in `dist/`.
 */

import { createRunRecord, type RunRecord, type StepRecord } from "./record.js";
import type { AfterIR, PlaybookIR, Scalar, StepIR, TransitionIR } from "../playbook/ir.js";
import { deepFreeze, toPlainJson } from "../playbook/ir.js";

export interface StepSpec extends Partial<Omit<StepIR, "id">> {
  readonly id: string;
}

const DEFAULT_OUTCOMES = ["success", "failure"] as const;

export function step(spec: StepSpec): StepIR {
  const { id: _id, ...overrides } = spec;
  return toPlainJson({
    id: spec.id,
    title: spec.title ?? spec.id,
    kind: spec.kind ?? "agent",
    needs: spec.needs ?? [],
    inputs: spec.inputs ?? {},
    outputs: spec.outputs ?? {},
    outcomes: spec.outcomes ?? [...DEFAULT_OUTCOMES],
    on: spec.on ?? {},
    pollMs: spec.pollMs ?? 3000,
    retries: spec.retries ?? 0,
    labels: spec.labels ?? {},
    ...overrides,
  }) as StepIR;
}

export interface PlaybookSpec {
  readonly id?: string;
  readonly steps: readonly StepIR[];
  readonly inputs?: PlaybookIR["inputs"];
  readonly concurrency?: number;
  readonly after?: readonly AfterIR[];
  /** Isolation block; defaults to `{ mode: "none" }` (no worktree). */
  readonly isolation?: PlaybookIR["isolation"];
}

export function playbook(spec: PlaybookSpec): PlaybookIR {
  const id = spec.id ?? "test";
  return deepFreeze(
    toPlainJson({
      version: 1 as const,
      id,
      title: id,
      description: "",
      hash: `test-hash-${id}`,
      inputs: spec.inputs ?? {},
      outputs: {},
      ...(spec.concurrency === undefined ? {} : { concurrency: spec.concurrency }),
      isolation: spec.isolation ?? { mode: "none" as const },
      steps: spec.steps,
      outcomes: [],
      blocks: {},
      after: spec.after ?? [],
      labels: {},
      roles: {},
    }) as PlaybookIR,
  );
}

export interface RecordSpec {
  readonly inputs?: Readonly<Record<string, Scalar>>;
  readonly cwd?: string;
  readonly now?: number;
  readonly deadline?: number;
}

export function makeRecord(ir: PlaybookIR, spec: RecordSpec = {}): RunRecord {
  const extra = {
    now: spec.now ?? 1_000,
    ...(spec.deadline === undefined ? {} : { deadline: spec.deadline }),
  };
  return createRunRecord({
    id: "run-1",
    ir,
    inputs: spec.inputs ?? {},
    cwd: spec.cwd ?? "/tmp/argos-run",
    ...extra,
  });
}

/** Test-only direct patch (bypasses the reducer) for pure-function unit tests. */
export function patchStep(record: RunRecord, stepId: string, patch: Partial<StepRecord>): RunRecord {
  const clone = JSON.parse(JSON.stringify(record)) as Record<string, never>;
  const steps = (clone as unknown as { steps: Record<string, StepRecord> }).steps;
  const current = steps[stepId];
  if (current === undefined) throw new Error(`unknown step ${stepId}`);
  steps[stepId] = { ...current, ...patch };
  const mutable = clone as unknown as { seq: number; updatedAt: number };
  mutable.seq += 1;
  mutable.updatedAt += 1;
  return deepFreeze(clone as unknown as RunRecord);
}

/** Deterministic PRNG for the property test (no dependency). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shorthand used by the transition tables. */
export function goto(target: string, maxLoops?: number): TransitionIR {
  return maxLoops === undefined ? { kind: "goto", target } : { kind: "goto", target, maxLoops };
}
