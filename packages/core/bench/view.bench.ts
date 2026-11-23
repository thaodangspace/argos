/**
 * The read model every client renders: `toRunSummary` (what `GET /runs` projects), its detail
 * variant, and the shared `@thaodangspace/argos-core/view` projections the Paseo panel and the web
 * UI both call.
 *
 * The panel polls every 2 s and re-projects on each frame, so these are the functions a user feels
 * when a list is large — a 200-run workspace with a 50-step run selected is the far end of the range
 * these benches keep cheap.
 *
 * Run: `npm run bench` (or `npx vitest bench packages/core/bench/view.bench.ts`).
 */

import { describe, test } from "vitest";

import type { RunDetail, RunSummary } from "../src/rpc/contracts.js";
import { stepDetailSummaries, toRunSummary } from "../src/rpc/summary.js";
import {
  attemptViews,
  buildRunLog,
  buildStepLog,
  daySections,
  filterRunViews,
  groupRuns,
  outputViews,
  panelView,
  runFacets,
  runView,
  sortRunViews,
  sortRuns,
  type PanelViewInput,
} from "../src/view/index.js";
import {
  BENCH_NOW,
  benchRecord,
  chainPlaybook,
  historyEvents,
  runToCompletion,
  withAttempts,
} from "./support.js";

const ATTEMPTS = 3;
const HISTORY = 500;
const FLEET = 200;

/** A finished 50-step run whose every step holds 3 attempts — the expensive detail projection. */
const record = withAttempts(runToCompletion(benchRecord(chainPlaybook({ steps: 50 }))), ATTEMPTS);
const doc = { taskId: "1", record };

const summary = toRunSummary(doc);
const steps = stepDetailSummaries(record);
const history = historyEvents(HISTORY, "step-00");
const detail: RunDetail = { ...summary, steps, history };

/** A small run repeated 200 times: what the list projects on every frame. */
const smallRecord = withAttempts(
  runToCompletion(benchRecord(chainPlaybook({ steps: 10 }))),
  ATTEMPTS,
);
const smallSummary = toRunSummary({ taskId: "1", record: smallRecord });
const fleet: RunSummary[] = [];
for (let index = 0; index < FLEET; index += 1) {
  fleet.push({
    ...smallSummary,
    id: `01JBENCHFLEET${String(index).padStart(8, "0")}`,
    playbookId: `bench-pb-${String(index % 8)}`,
    updatedAt: smallSummary.updatedAt + index,
    seq: index,
  });
}

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

const stepSummary = steps[0];
if (stepSummary === undefined) throw new Error("bench: the fixture must have at least one step");
const stepLogInput = {
  step: stepSummary,
  history,
  gates: summary.gates,
  attempts: attemptViews(stepSummary.attempts),
  outputs: outputViews(stepSummary.outputs),
  ...(stepSummary.outcome === undefined ? {} : { outcome: stepSummary.outcome }),
};
const runViews = fleet.map((run) => runView(run, { now: BENCH_NOW }));

describe("read model", () => {
  test("run summary projection", async ({ bench }) => {
    await bench.compare(
      bench(`toRunSummary, 50 steps x ${String(ATTEMPTS)} attempts`, () => {
        toRunSummary(doc);
      }),
      bench(`stepDetailSummaries, 50 steps x ${String(ATTEMPTS)} attempts`, () => {
        stepDetailSummaries(record);
      }),
    );
  });

  test("run views", async ({ bench }) => {
    await bench.compare(
      bench("runView, 50-step run", () => {
        runView(summary, { now: BENCH_NOW });
      }),
      bench("runView, 50-step run with detail + history", () => {
        runView(summary, { detail, now: BENCH_NOW });
      }),
      bench(`panelView, ${String(FLEET)} runs x 10 steps`, () => {
        panelView(panel, { now: BENCH_NOW });
      }),
      bench(`sortRuns over ${String(FLEET)} summaries`, () => {
        sortRuns(fleet);
      }),
      bench(`groupRuns over ${String(FLEET)} run views`, () => {
        groupRuns(runViews);
      }),
      bench(`list timeline over ${String(FLEET)} run views`, () => {
        sortRunViews(filterRunViews(runViews, { status: "completed" }), "start");
      }),
      bench(`facets over ${String(FLEET)} run views`, () => {
        runFacets(runViews);
      }),
      bench(`day sections over ${String(FLEET)} run views`, () => {
        daySections(sortRunViews(runViews, "start"), BENCH_NOW);
      }),
    );
  });

  test("step log", async ({ bench }) => {
    await bench.compare(
      bench(`buildStepLog, ${String(HISTORY)} history events`, () => {
        buildStepLog(stepLogInput);
      }),
      bench(`buildRunLog, ${String(HISTORY)} history events`, () => {
        buildRunLog(history);
      }),
    );
  });
});
