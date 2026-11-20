/**
 * Shared plumbing for the perf benches (`npm run bench`) and the opt-in budget guard
 * (`packages/core/test/perf/budget.test.ts`).
 *
 * Only the three deterministic layers are measured: the pure reducer a host drives on every wake,
 * the loader that runs once per start/fire, and the read-model projections every client renders.
 * Nothing here opens SQLite, a socket, or a real clock, so a number from these files describes
 * Argos and not the machine it happened to run on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunRecord,
  isTerminalRunStatus,
  next,
  type Effect,
  type RunRecord,
} from "../src/engine/index.js";
import { patchStep, playbook, step } from "../src/engine/test-util.js";
import type { HistoryEvent } from "../src/rpc/contracts.js";
import type { PlaybookIR, Scalar } from "../src/playbook/ir.js";
import type { AttemptRecord } from "../src/engine/index.js";

/** Fixed event time: the benches must not read the clock (the pure engine never does). */
export const BENCH_NOW = 1_700_000_000_000;
export const BENCH_RUN_ID = "01JBENCH000000000000000000";
export const BENCH_CWD = "/tmp/argos-bench";
export const BENCH_TARGET = "paseo/bench-model";
export const BENCH_USAGE: Readonly<Record<string, number>> = {
  inputTokens: 1_200,
  outputTokens: 300,
  totalCostUsd: 0.012,
};
export const BENCH_INPUTS: Readonly<Record<string, Scalar>> = { request: "bench" };

// ------------------------------------------------------------------ playbook shapes

export interface PlaybookShape {
  readonly steps: number;
  /** Report one declared output per step; a step without outputs settles on its outcome alone. */
  readonly outputs?: boolean;
  /** Maximum running steps; omitted means unlimited. */
  readonly concurrency?: number;
}

function benchStepId(index: number): string {
  return `step-${String(index).padStart(2, "0")}`;
}

function benchStep(
  index: number,
  needs: readonly string[],
  outputs: boolean,
): PlaybookIR["steps"][number] {
  return step({
    id: benchStepId(index),
    needs,
    ...(outputs ? { outputs: { result: { type: "string" as const } } } : {}),
  });
}

/** A linear chain: one ready step at a time, the shape most playbooks have. */
export function chainPlaybook(shape: PlaybookShape): PlaybookIR {
  const outputs = shape.outputs ?? true;
  const steps = [];
  for (let index = 0; index < shape.steps; index += 1) {
    steps.push(benchStep(index, index === 0 ? [] : [benchStepId(index - 1)], outputs));
  }
  return playbook({
    id: `bench-chain-${shape.steps}`,
    steps,
    ...(shape.concurrency === undefined ? {} : { concurrency: shape.concurrency }),
  });
}

/**
 * A diamond-free wide graph: every step is independent, so one tick dispatches the whole graph.
 * This is the worst case for the readiness scan.
 */
export function widePlaybook(shape: PlaybookShape): PlaybookIR {
  const outputs = shape.outputs ?? true;
  const steps = [];
  for (let index = 0; index < shape.steps; index += 1) steps.push(benchStep(index, [], outputs));
  return playbook({
    id: `bench-wide-${shape.steps}`,
    steps,
    ...(shape.concurrency === undefined ? {} : { concurrency: shape.concurrency }),
  });
}

// ------------------------------------------------------------------ run records

export function benchRecord(
  ir: PlaybookIR,
  options: { readonly inputs?: Readonly<Record<string, Scalar>>; readonly deadline?: number } = {},
): RunRecord {
  return createRunRecord({
    id: BENCH_RUN_ID,
    ir,
    inputs: options.inputs ?? BENCH_INPUTS,
    cwd: BENCH_CWD,
    now: BENCH_NOW,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
}

/** `record` after one tick plus the attempt it dispatched, so the run is genuinely mid-flight. */
export function startFirstStep(record: RunRecord): RunRecord {
  const ticked = next(record, { type: "tick", now: record.createdAt });
  let current = ticked.record;
  for (const effect of ticked.effects) {
    if (effect.type !== "dispatchStep") continue;
    current = next(current, {
      type: "stepAttemptStarted",
      stepId: effect.stepId,
      attempt: effect.attempt,
      startedAt: record.createdAt + 1,
      target: BENCH_TARGET,
    }).record;
  }
  return current;
}

/**
 * Tick and settle until the run is terminal (or nothing moves any more), which is what the durable
 * host does over many wakes. The reducer dispatches from inside both the tick and the settle, so
 * the driver keeps a queue of `dispatchStep` effects instead of assuming one dispatch per tick.
 * Used for setup only: the benches measure single events, not this.
 */
export function runToCompletion(record: RunRecord): RunRecord {
  let current = record;
  let now = record.createdAt;
  const queue: { stepId: string; attempt: number }[] = [];

  const tick = (): number => {
    const result = next(current, { type: "tick", now });
    current = result.record;
    for (const effect of result.effects) {
      if (effect.type === "dispatchStep") {
        queue.push({ stepId: effect.stepId, attempt: effect.attempt });
      }
    }
    return result.effects.length;
  };

  tick();
  for (let guard = 0; guard < 100_000; guard += 1) {
    const item = queue.shift();
    if (item === undefined) {
      if (isTerminalRunStatus(current.status)) break;
      // Nothing queued and nothing to dispatch: a gate or a delay step, which this driver does not
      // answer. Stop rather than spin.
      if (tick() === 0) break;
      continue;
    }
    now += 10;
    const started = next(current, {
      type: "stepAttemptStarted",
      stepId: item.stepId,
      attempt: item.attempt,
      startedAt: now,
      target: BENCH_TARGET,
    });
    current = started.record;
    now += 5;
    const settled = next(current, {
      type: "stepSettled",
      stepId: item.stepId,
      outcome: "success",
      outputs: { result: `output of ${item.stepId}` },
      usage: BENCH_USAGE,
      endedAt: now,
    });
    current = settled.record;
    for (const effect of settled.effects) {
      if (effect.type === "dispatchStep") {
        queue.push({ stepId: effect.stepId, attempt: effect.attempt });
      }
    }
  }
  return current;
}

/**
 * The same record with `count` recorded attempts on every step. The engine records one attempt per
 * dispatch (a local retry lives in the step checkpoint), so this is what a long-running step looks
 * like to the read model — the input the attempt projections are measured against.
 */
export function withAttempts(record: RunRecord, count: number): RunRecord {
  if (count <= 1) return record;
  let current = record;
  for (const definition of record.ir.steps) {
    const state = record.steps[definition.id];
    if (state === undefined) continue;
    const attempts: AttemptRecord[] = [];
    for (let n = 1; n <= count; n += 1) {
      attempts.push({
        n,
        target: BENCH_TARGET,
        requestId: `argos:${record.id}:${definition.id}:${n}`,
        startedAt: BENCH_NOW + n * 1_000,
        endedAt: BENCH_NOW + n * 1_000 + 900,
        outcome: "completed",
        usage: BENCH_USAGE,
      });
    }
    current = patchStep(current, definition.id, { attempts });
  }
  return current;
}

/** A bounded history document: `count` events, half dispatch half settle, all on one step. */
export function historyEvents(count: number, stepId: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      at: BENCH_NOW + index * 1_000,
      seq: index,
      type: index % 2 === 0 ? "dispatch" : "settle",
      stepId,
      attempt: 1,
      detail: "bench",
    });
  }
  return events;
}

// ------------------------------------------------------------------ a throwaway repo

export interface BenchRepo {
  readonly dir: string;
  readonly playbookDir: string;
  write(id: string, body: string): void;
  cleanup(): void;
}

/** A temp repo with `.argos/playbooks/`, so the loader benches hit real files. */
export function makeBenchRepo(): BenchRepo {
  const dir = mkdtempSync(join(tmpdir(), "argos-bench-"));
  const playbookDir = join(dir, ".argos", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  return {
    dir,
    playbookDir,
    write(id: string, body: string): void {
      writeFileSync(join(playbookDir, `${id}.yaml`), body);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A playbook as YAML, generated rather than committed: a fixture would have to be regenerated
 * every time the schema grows, and the bench measures the pipeline (parse → zod → resolve → hash →
 * freeze) on a shape that is representative rather than special.
 */
export function playbookYaml(id: string, stepCount: number): string {
  const lines: string[] = [
    `title: Bench ${id}`,
    "description: Generated by the bench suite; never committed.",
    "inputs:",
    "  request:",
    "    type: string",
    "    required: true",
    "  base_branch:",
    "    type: string",
    "    default: main",
    "steps:",
  ];
  for (let index = 0; index < stepCount; index += 1) {
    const name = benchStepId(index);
    lines.push(`  - id: ${name}`);
    if (index > 0) lines.push(`    needs: [${benchStepId(index - 1)}]`);
    lines.push("    prompt: |");
    lines.push(`      Work on {{ inputs.request }} against {{ inputs.base_branch }} (${name}).`);
    lines.push("    outputs:");
    lines.push("      result:");
    lines.push("        type: string");
    lines.push("        description: What this step produced");
  }
  return `${lines.join("\n")}\n`;
}
