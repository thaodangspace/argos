/**
 * The pure reducer (`next`) — the engine's real throughput ceiling.
 *
 * `argos.run` feeds `next` on every wake (a tick, a child settle, a gate decision), and each call
 * deep-clones the checkpoint and compares it to the input by JSON. That is deliberate (the record is
 * frozen and the reducer never mutates), but it means an accidental quadratic step in the readiness
 * scan would be invisible in the unit suite and painful in a 100-step playbook. These benches make
 * the per-event cost and its scaling visible.
 *
 * Run: `npm run bench` (or `npx vitest bench packages/core/bench/engine.bench.ts`).
 * `--project` does not work for benchmarks in this vitest version (a bench project is registered
 * under `<name> (bench)`), so the file path is the filter.
 */

import { describe, test } from "vitest";

import { createRunRecord, next, readySteps, type EngineEvent } from "../src/engine/index.js";
import {
  BENCH_NOW,
  benchRecord,
  chainPlaybook,
  runToCompletion,
  startFirstStep,
  widePlaybook,
} from "./support.js";

const SMALL = 10;
const LARGE = 100;

const smallChain = chainPlaybook({ steps: SMALL });
const largeChain = chainPlaybook({ steps: LARGE });
const wide = widePlaybook({ steps: LARGE, concurrency: 4 });

const freshSmall = benchRecord(smallChain);
const freshLarge = benchRecord(largeChain);
const freshWide = benchRecord(wide);

/** Mid-run: the first step holds an in-flight attempt, so a tick has a real decision to make. */
const midSmall = startFirstStep(freshSmall);
const midLarge = startFirstStep(freshLarge);

/** The deadline path: one tick has to fail every running step and finish the run. */
const almostExpired = benchRecord(largeChain, { deadline: BENCH_NOW + 1_000 });

const settledLarge = runToCompletion(freshLarge);

const settleFirst: EngineEvent = {
  type: "stepSettled",
  stepId: "step-00",
  outcome: "success",
  outputs: { result: "ok" },
  usage: { inputTokens: 1_200, outputTokens: 300, totalCostUsd: 0.012 },
  endedAt: BENCH_NOW + 5_000,
};

const failFirst: EngineEvent = {
  type: "stepSettled",
  stepId: "step-00",
  errorCode: "step_failed",
  endedAt: BENCH_NOW + 5_000,
};

describe("engine", () => {
  test("next(tick)", async ({ bench }) => {
    await bench.compare(
      bench("10-step chain, dispatch the first step", () => {
        next(freshSmall, { type: "tick", now: BENCH_NOW });
      }),
      bench("100-step chain, nothing due", () => {
        next(midLarge, { type: "tick", now: BENCH_NOW + 3_000 });
      }),
      bench("100-step wide graph, dispatch up to concurrency", () => {
        next(freshWide, { type: "tick", now: BENCH_NOW });
      }),
      bench("100-step chain, deadline reached (fail everything)", () => {
        next(almostExpired, { type: "tick", now: BENCH_NOW + 60_000 });
      }),
      bench("100-step chain, terminal (immutable)", () => {
        next(settledLarge, { type: "tick", now: BENCH_NOW + 60_000 });
      }),
    );
  });

  test("next(stepSettled)", async ({ bench }) => {
    await bench.compare(
      bench("10-step chain, settle then dispatch the next", () => {
        next(midSmall, settleFirst);
      }),
      bench("100-step chain, settle then dispatch the next", () => {
        next(midLarge, settleFirst);
      }),
      bench("100-step chain, settle as a failure (finish the run)", () => {
        next(midLarge, failFirst);
      }),
    );
  });

  test("readiness scan", async ({ bench }) => {
    await bench.compare(
      bench("readySteps on a 10-step chain", () => {
        readySteps(midSmall, BENCH_NOW + 3_000);
      }),
      bench("readySteps on a 100-step chain", () => {
        readySteps(midLarge, BENCH_NOW + 3_000);
      }),
    );
  });

  test("record creation", async ({ bench }) => {
    await bench.compare(
      bench("createRunRecord for a 10-step playbook", () => {
        createRunRecord({
          id: "run-bench",
          ir: smallChain,
          inputs: { request: "bench" },
          cwd: "/tmp/argos-bench",
          now: BENCH_NOW,
        });
      }),
      bench("createRunRecord for a 100-step playbook", () => {
        createRunRecord({
          id: "run-bench",
          ir: largeChain,
          inputs: { request: "bench" },
          cwd: "/tmp/argos-bench",
          now: BENCH_NOW,
        });
      }),
    );
  });

  test("whole run", async ({ bench }) => {
    await bench("drive a 25-step chain to completion (the host loop)", () => {
      runToCompletion(benchRecord(chainPlaybook({ steps: 25 })));
    }).run();
  });
});

