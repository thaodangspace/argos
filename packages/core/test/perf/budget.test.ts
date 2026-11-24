/**
 * Performance-budget guard: `npm run test:perf`.
 *
 * The benches in `packages/core/bench/` report numbers; this file turns the ones that would hurt a
 * user into an assertion. It is a **separate project** (`vitest.perf.config.ts`) for the same reason
 * the E2E suite is: a timing depends on the machine, so `npm test` must never gate on one. The
 * budgets are deliberately loose (roughly 10x the reference laptop) — they are here to catch an
 * accidental O(n^2) or a projection that starts copying a transcript, not to police a 5 % drift.
 * Refresh them only when a deliberate change makes the headroom meaningless.
 *
 * Two kinds of check:
 *   - **ceiling**: one hot path may not exceed a per-call budget;
 *   - **scaling**: 10x the steps may not cost much more than 10x the time (a ratio, so it holds on
 *     a slow machine).
 */

import { afterAll, describe, expect, it } from "vitest";

import { createRunRecord, next } from "../../src/engine/index.js";
import { buildPlaybookGraph, loadPlaybook, playbookHash } from "../../src/playbook/index.js";
import { stepDetailSummaries, toRunSummary } from "../../src/rpc/summary.js";
import {
  attemptViews,
  buildStepLog,
  layerGraph,
  outputViews,
  panelView,
  renderMermaid,
  runView,
} from "../../src/view/index.js";
import type { PanelViewInput } from "../../src/view/index.js";
import {
  BENCH_NOW,
  benchRecord,
  chainPlaybook,
  historyEvents,
  makeBenchRepo,
  playbookYaml,
  runToCompletion,
  withAttempts,
} from "../../bench/support.js";

/** Median of five samples of `iterations` calls, in milliseconds per call. */
function timePerOp(run: () => void): number {
  for (let warmup = 0; warmup < 10; warmup += 1) run();
  const probeStart = performance.now();
  run();
  const probe = Math.max(performance.now() - probeStart, 0.0005);
  // Enough calls that one sample lasts at least ~50 ms, so the timer's own noise stays small.
  const iterations = Math.min(20_000, Math.max(20, Math.ceil(50 / probe)));
  const samples: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) run();
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((left, right) => left - right);
  return samples[2] ?? Number.POSITIVE_INFINITY;
}

// ------------------------------------------------------------------ fixtures

const chain10 = chainPlaybook({ steps: 10 });
const chain100 = chainPlaybook({ steps: 100 });

// The graph rows: a 20-step graph is the ceiling fixture, 200 steps the scaled one.
const ir20 = chainPlaybook({ steps: 20 });
const ir200 = chainPlaybook({ steps: 200 });
const graph20 = buildPlaybookGraph(ir20);
const graph200 = buildPlaybookGraph(ir200);

const fresh10 = benchRecord(chain10);
const fresh100 = benchRecord(chain100);

const settled10 = runToCompletion(fresh10);
const settled100 = runToCompletion(fresh100);

/** One tick dispatches step-00, so the record is genuinely mid-run. */
const mid10 = next(fresh10, { type: "tick", now: BENCH_NOW }).record;
const mid100 = next(fresh100, { type: "tick", now: BENCH_NOW }).record;

const record50 = withAttempts(runToCompletion(benchRecord(chainPlaybook({ steps: 50 }))), 3);
const doc50 = { taskId: "1", record: record50 };
const summary50 = toRunSummary(doc50);
const steps50 = stepDetailSummaries(record50);
const history = historyEvents(500, "step-00");
const detail50 = { ...summary50, steps: steps50, history };

const step50 = steps50[0];
if (step50 === undefined) throw new Error("budget: the 50-step fixture has no steps");
const stepLogInput = {
  step: step50,
  history,
  gates: summary50.gates,
  attempts: attemptViews(step50.attempts),
  outputs: outputViews(step50.outputs),
};

const smallSummary = toRunSummary({ taskId: "1", record: settled10 });
const fleet = Array.from({ length: 200 }, (_unused, index) => ({
  ...smallSummary,
  id: `01JBUDGETFLEET${String(index).padStart(8, "0")}`,
  playbookId: `budget-pb-${String(index % 8)}`,
  updatedAt: smallSummary.updatedAt + index,
  seq: index,
}));
const panel: PanelViewInput = {
  runs: fleet,
  gates: [],
  inFlight: [],
  busyRuns: [],
  detail: null,
  selectedRunId: null,
  detailLoading: false,
  filter: "all",
  loading: false,
  connected: true,
  error: null,
};

const repo = makeBenchRepo();
repo.write("budget-10", playbookYaml("budget-10", 10));
repo.write("budget-40", playbookYaml("budget-40", 40));
const ir40 = loadPlaybook(repo.dir, "budget-40");

afterAll(() => {
  repo.cleanup();
});

// ------------------------------------------------------------------ ceilings

describe("perf budget: ceilings (ms per call)", () => {
  it("next(tick) on a 100-step run", () => {
    const ms = timePerOp(() => {
      next(fresh100, { type: "tick", now: BENCH_NOW + 3_000 });
    });
    expect(ms, "next(tick) 100 steps").toBeLessThan(5);
  });

  it("next(stepSettled) on a 100-step run", () => {
    const ms = timePerOp(() => {
      next(mid100, {
        type: "stepSettled",
        stepId: "step-00",
        outcome: "success",
        outputs: { result: "ok" },
        endedAt: BENCH_NOW + 5_000,
      });
    });
    expect(ms, "next(stepSettled) 100 steps").toBeLessThan(5);
  });

  it("createRunRecord for a 100-step playbook", () => {
    const ms = timePerOp(() => {
      benchRecord(chain100);
    });
    expect(ms, "createRunRecord 100 steps").toBeLessThan(1);
  });

  it("driving a 25-step chain to completion", () => {
    const record = benchRecord(chainPlaybook({ steps: 25 }));
    const ms = timePerOp(() => {
      runToCompletion(record);
    });
    expect(ms, "runToCompletion 25 steps").toBeLessThan(25);
  });

  it("loadPlaybook for a 40-step playbook", () => {
    const ms = timePerOp(() => {
      loadPlaybook(repo.dir, "budget-40");
    });
    expect(ms, "loadPlaybook 40 steps").toBeLessThan(30);
  });

  it("playbookHash of a 40-step IR", () => {
    const ms = timePerOp(() => {
      playbookHash(ir40);
    });
    expect(ms, "playbookHash 40 steps").toBeLessThan(1);
  });

  it("toRunSummary + stepDetailSummaries for a 50-step run", () => {
    const ms = timePerOp(() => {
      toRunSummary(doc50);
      stepDetailSummaries(record50);
    });
    expect(ms, "summary projection 50 steps").toBeLessThan(2);
  });

  it("runView for a 50-step run with detail and history", () => {
    const ms = timePerOp(() => {
      runView(summary50, { detail: detail50, now: BENCH_NOW });
    });
    expect(ms, "runView 50 steps").toBeLessThan(15);
  });

  it("panelView over 200 runs of 10 steps", () => {
    const ms = timePerOp(() => {
      panelView(panel, { now: BENCH_NOW });
    });
    expect(ms, "panelView 200 runs").toBeLessThan(40);
  });

  it("buildStepLog over 500 history events", () => {
    const ms = timePerOp(() => {
      buildStepLog(stepLogInput);
    });
    expect(ms, "buildStepLog 500 events").toBeLessThan(5);
  });

  it("buildPlaybookGraph for a 20-step playbook", () => {
    const ms = timePerOp(() => {
      buildPlaybookGraph(ir20);
    });
    expect(ms, "buildPlaybookGraph 20 steps").toBeLessThan(0.25);
  });

  it("renderMermaid for a 20-step graph", () => {
    const ms = timePerOp(() => {
      renderMermaid(graph20);
    });
    expect(ms, "renderMermaid 20 steps").toBeLessThan(0.25);
  });

  it("ticking a terminal run is free", () => {
    // The reducer returns before cloning, so this must stay an order of magnitude below a live
    // tick. The measurement floor is the timer, not the call: 0.15 ms still separates the paths.
    const ms = timePerOp(() => {
      next(settled100, { type: "tick", now: BENCH_NOW + 60_000 });
    });
    expect(ms, "terminal tick").toBeLessThan(0.15);
  });

  it("ticking a 10-step chain (the small-run floor)", () => {
    const ms = timePerOp(() => {
      next(fresh10, { type: "tick", now: BENCH_NOW });
    });
    expect(ms, "next(tick) 10 steps").toBeLessThan(1);
  });

  it("the fixed cost of a createRunRecord on a 10-step playbook", () => {
    const ms = timePerOp(() => {
      createRunRecord({
        id: "run-budget",
        ir: chain10,
        inputs: { request: "budget" },
        cwd: "/tmp/argos-budget",
        now: BENCH_NOW,
      });
    });
    expect(ms, "createRunRecord 10 steps").toBeLessThan(0.5);
  });
});

// ------------------------------------------------------------------ scaling

describe("perf budget: scaling (10x the steps)", () => {
  it("next(stepSettled) grows with the step count, not with its square", () => {
    const settle = (record: typeof mid100): number =>
      timePerOp(() => {
        next(record, {
          type: "stepSettled",
          stepId: "step-00",
          outcome: "success",
          outputs: { result: "ok" },
          endedAt: BENCH_NOW + 5_000,
        });
      });
    const small = settle(mid10);
    const large = settle(mid100);
    // 10x the steps may cost at most 25x the time; quadratic growth would be ~100x.
    expect(large / small, `100-step / 10-step = ${String(large / small)}x`).toBeLessThan(25);
  });

  it("the summary projection grows linearly with the step count", () => {
    const summarize = (record: typeof record50): number =>
      timePerOp(() => {
        toRunSummary({ taskId: "1", record });
      });
    const record10 = withAttempts(settled10, 3);
    const small = summarize(record10);
    const large = summarize(record50);
    // 5x the steps, at most 15x the time.
    expect(large / small, `50-step / 10-step = ${String(large / small)}x`).toBeLessThan(15);
  });

  it("loadPlaybook stays near-linear in the step count", () => {
    const load = (id: string): number =>
      timePerOp(() => {
        loadPlaybook(repo.dir, id);
      });
    const small = load("budget-10");
    const large = load("budget-40");
    // 4x the steps, at most 12x the time (parsing has a fixed cost, so some slack is expected).
    expect(large / small, `40-step / 10-step = ${String(large / small)}x`).toBeLessThan(12);
  });

  it("the graph projector grows linearly with the step count", () => {
    const project = (ir: typeof ir20): number =>
      timePerOp(() => {
        buildPlaybookGraph(ir);
      });
    const small = project(ir20);
    const large = project(ir200);
    // 10x the steps may cost at most 25x the time; quadratic growth would be ~100x.
    expect(large / small, `200-step / 20-step = ${String(large / small)}x`).toBeLessThan(25);
  });

  it("the graph layout grows linearly with the node count", () => {
    const layout = (graph: typeof graph20): number =>
      timePerOp(() => {
        layerGraph(graph);
      });
    const small = layout(graph20);
    const large = layout(graph200);
    // 10x the nodes may cost at most 25x the time; quadratic growth would be ~100x.
    expect(large / small, `200-step / 20-step = ${String(large / small)}x`).toBeLessThan(25);
  });
});
