/**
 * Read-model detail projection (`GET /runs/:id`): the list stays lean, the detail carries what the
 * panel's per-step log renders (attempts, outcome, declared outputs) and nothing else.
 */

import { describe, expect, it } from "vitest";

import { createRunRecord, next, type GateRecord, type RunRecord } from "../../src/engine/index.js";
import { playbook, step } from "../../src/engine/test-util.js";
import { buildPlaybookGraph } from "../../src/playbook/graph.js";
import {
  GateSummarySchema,
  RunDetailSchema,
  STEP_OUTPUT_VALUE_LIMIT,
  type RunDetail,
} from "../../src/rpc/contracts.js";
import { toGateSummary, toRunDetail, toRunSummary } from "../../src/rpc/summary.js";

const ir = playbook({
  id: "demo",
  steps: [
    step({ id: "pick", title: "Pick" }),
    step({ id: "ship", title: "Ship", needs: ["pick"] }),
  ],
});

/** A run with one settled step: an attempt, an outcome, and outputs (one of them secret-named). */
function settledRecord(): RunRecord {
  let record = createRunRecord({ id: "run-1", ir, inputs: {}, cwd: "/repo", now: 1_000 });
  record = next(record, { type: "tick", now: 1_000 }).record;
  record = next(record, {
    type: "stepAttemptStarted",
    stepId: "pick",
    attempt: 1,
    startedAt: 1_100,
    target: "claude/opus",
    now: 1_100,
  }).record;
  record = next(record, {
    type: "stepSettled",
    stepId: "pick",
    endedAt: 2_000,
    outcome: "success",
    outputs: { stdout: "specs/VP-7.md\n", api_token: "secret-value" },
    usage: { inputTokens: 12, outputTokens: 34 },
    now: 2_000,
  }).record;
  return record;
}

function detail(record: RunRecord): RunDetail {
  return toRunDetail({ taskId: "42", record }, { events: [] });
}

/** One pending step gate, as the engine stores it. */
const gate: GateRecord = {
  id: "review:1",
  kind: "step",
  stepId: "review",
  question: "Ship it?",
  choices: { approve: { label: "Approve", comment: "none" } },
  status: "pending",
  createdAt: 1_700_000_000_000,
};

describe("toGateSummary (gate age, inbox FR1)", () => {
  it("projects the gate's createdAt", () => {
    const summary = toGateSummary("run-1", gate);
    expect(summary.createdAt).toBe(1_700_000_000_000);
    // The strict public schema accepts the projection as-is (a stray key would fail here).
    expect(GateSummarySchema.parse(summary).createdAt).toBe(1_700_000_000_000);
  });

  it("omits the key for a record that predates the field", () => {
    const { createdAt: _dropped, ...rest } = gate;
    const legacy = rest as unknown as GateRecord;

    const summary = toGateSummary("run-1", legacy);
    expect(summary).not.toHaveProperty("createdAt");
    // Absent, never `null` or `0`: the JSON of a hand-built fixture stays stable.
    expect(JSON.stringify(summary)).not.toContain("createdAt");
  });

  it("accepts a gate object without createdAt (an older server)", () => {
    const older = {
      runId: "run-1",
      gateId: "review:1",
      stepId: "review",
      kind: "step",
      question: "Ship it?",
      choices: { approve: { label: "Approve", comment: "none" } },
      status: "pending",
    };

    expect(GateSummarySchema.parse(older)).not.toHaveProperty("createdAt");
    expect(GateSummarySchema.parse({ ...older, createdAt: 1_700_000_000_000 }).createdAt).toBe(
      1_700_000_000_000,
    );
  });
});

describe("toRunDetail (step logs)", () => {
  it("carries attempts, outcome, and declared outputs per step", () => {
    const run = detail(settledRecord());
    expect(run.steps.map((entry) => entry.id)).toEqual(["pick", "ship"]);

    const pick = run.steps[0];
    expect(pick).toMatchObject({
      id: "pick",
      title: "Pick",
      status: "completed",
      outcome: "success",
      attemptCount: 1,
      startedAt: 1_100,
      endedAt: 2_000,
      attempts: [
        {
          n: 1,
          startedAt: 1_100,
          endedAt: 2_000,
          target: "claude/opus",
          usage: { inputTokens: 12, outputTokens: 34 },
        },
      ],
    });
    // The declared outputs are the step's log; a credential-shaped name never crosses the wire.
    expect(pick?.outputs).toEqual({ stdout: "specs/VP-7.md\n" });
    expect(pick).not.toHaveProperty("prompt");
    expect(JSON.stringify(pick)).not.toContain("secret-value");

    // The next step was dispatched by the settle tick: it has an open attempt and no output.
    expect(run.steps[1]?.attempts).toEqual([{ n: 1, startedAt: 2_000 }]);
    expect(run.steps[1]).not.toHaveProperty("outputs");

    // The strict detail schema accepts exactly the projected shape.
    expect(RunDetailSchema.parse(run).steps[0]?.attempts).toHaveLength(1);
  });

  it("truncates an oversized output string and keeps the marker", () => {
    let record = createRunRecord({ id: "run-2", ir, inputs: {}, cwd: "/repo", now: 1_000 });
    record = next(record, { type: "tick", now: 1_000 }).record;
    record = next(record, {
      type: "stepSettled",
      stepId: "pick",
      endedAt: 2_000,
      outcome: "success",
      outputs: { stdout: "x".repeat(STEP_OUTPUT_VALUE_LIMIT + 50) },
      now: 2_000,
    }).record;

    const pick = detail(record).steps[0];
    const stdout = pick?.outputs?.["stdout"];
    expect(typeof stdout).toBe("string");
    expect(String(stdout)).toHaveLength(STEP_OUTPUT_VALUE_LIMIT + "… (truncated)".length);
    expect(String(stdout).endsWith("… (truncated)")).toBe(true);
  });

  it("keeps the list summary lean (no attempts, outputs, or outcome)", () => {
    const summary = toRunSummary({ taskId: "42", record: settledRecord() });
    const pick = summary.steps[0] as unknown as Record<string, unknown>;
    expect(pick["attemptCount"]).toBe(1);
    expect(pick["attempts"]).toBeUndefined();
    expect(pick["outputs"]).toBeUndefined();
    expect(pick["outcome"]).toBeUndefined();
  });

  it("projects fork provenance only when the record has it (S-FR5)", () => {
    const plain = toRunSummary({ taskId: "42", record: settledRecord() });
    expect(Object.keys(plain)).not.toContain("forkedFrom");

    const forkedFrom = {
      runId: "run-parent",
      stepId: "pick",
      fromHash: "c".repeat(64),
      toHash: "d".repeat(64),
    } as const;
    const forked = toRunSummary({
      taskId: "43",
      record: { ...settledRecord(), forkedFrom },
    });
    expect(forked.forkedFrom).toEqual(forkedFrom);
    // The public schema accepts the projection as-is (strict, so a stray key fails here).
    expect(RunDetailSchema.safeParse(toRunDetail({ taskId: "43", record: { ...settledRecord(), forkedFrom } }, { events: [] })).success).toBe(true);
  });

  it("projects a non-default executor and drops an explicit paseo (FR8)", () => {
    const record = settledRecord();
    // A paseo run names nothing: the key is absent, not `"paseo"`.
    expect(toRunSummary({ taskId: "42", record })).not.toHaveProperty("executor");
    expect(JSON.stringify(toRunSummary({ taskId: "42", record }))).not.toContain('"executor"');

    const hc = toRunSummary({ taskId: "43", record: { ...record, executor: "hc" } });
    expect(hc.executor).toBe("hc");
    expect(RunDetailSchema.safeParse(detail({ ...record, executor: "hc" })).success).toBe(true);

    // A record that spelled the default out is filtered here too, so the wire shape is uniform.
    const explicit = toRunSummary({ taskId: "44", record: { ...record, executor: "paseo" } });
    expect(explicit).not.toHaveProperty("executor");
  });

  it("aggregates a step's attempts and the run total (FR26)", () => {
    const record = settledRecord();
    const summary = toRunSummary({ taskId: "42", record });
    expect(summary.steps[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(summary.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    // The detail projection inherits both through StepDetailSummary.
    expect(detail(record).steps[0]?.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(RunDetailSchema.safeParse(detail(record)).success).toBe(true);
  });

  it("keeps usage absent when no attempt reported accounting", () => {
    let record = createRunRecord({ id: "run-3", ir, inputs: {}, cwd: "/repo", now: 1_000 });
    record = next(record, { type: "tick", now: 1_000 }).record;
    record = next(record, {
      type: "stepSettled",
      stepId: "pick",
      endedAt: 2_000,
      outcome: "success",
      now: 2_000,
    }).record;

    const summary = toRunSummary({ taskId: "42", record });
    expect(summary.steps[0]).not.toHaveProperty("usage");
    expect(summary).not.toHaveProperty("usage");
    expect(JSON.stringify(summary)).not.toContain('"usage"');
  });
});

describe("toRunDetail (script attempt logs: FR5, FR6, FR7)", () => {
  /**
   * A run whose single script step settled one attempt carrying its own output tails, exactly as
   * `argos.script`'s receipt reaches the reducer after Phase 2.
   */
  function scriptRecord(options: {
    readonly outputs?: Readonly<Record<string, string>>;
    readonly streams?: { readonly stdout?: string; readonly stderr?: string };
    readonly detail?: string;
    readonly exitCode?: number;
  }): RunRecord {
    const scripted = playbook({
      id: "scripted",
      steps: [
        step({
          id: "run",
          kind: "script",
          outputs: {
            stdout: { type: "string" },
            stderr: { type: "string" },
            note: { type: "string" },
          },
        }),
      ],
    });
    let record = createRunRecord({
      id: "run-script",
      ir: scripted,
      inputs: {},
      cwd: "/repo",
      now: 1_000,
    });
    record = next(record, { type: "tick", now: 1_000 }).record;
    record = next(record, {
      type: "stepSettled",
      stepId: "run",
      endedAt: 2_000,
      ...(options.detail === undefined ? {} : { errorCode: "step_failed" as const }),
      ...(options.detail === undefined ? { outcome: "success" } : {}),
      ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
      ...(options.streams === undefined ? {} : { streams: options.streams }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
      now: 2_000,
    }).record;
    return record;
  }

  it("keeps the last STEP_OUTPUT_VALUE_LIMIT characters behind the marker (FR6)", () => {
    const long = `${"start-".repeat(834)}${"z".repeat(STEP_OUTPUT_VALUE_LIMIT)}`;
    expect(long.length).toBeGreaterThan(STEP_OUTPUT_VALUE_LIMIT);
    const record = scriptRecord({ streams: { stdout: long }, exitCode: 0 });

    const attempt = detail(record).steps[0]?.attempts[0];
    const stdout = attempt?.streams?.stdout ?? "";
    expect(stdout.startsWith("… (truncated)\n")).toBe(true);
    // The marker line plus exactly the limit — the *end* of the log, never its start.
    expect(stdout.slice("… (truncated)\n".length)).toBe(long.slice(long.length - STEP_OUTPUT_VALUE_LIMIT));
    expect(stdout).toContain("z".repeat(STEP_OUTPUT_VALUE_LIMIT));
    expect(attempt?.exitCode).toBe(0);
  });

  it("copies a short stream verbatim and never marks it", () => {
    const record = scriptRecord({ streams: { stdout: "blocked\n", stderr: "waiting for quota\n" } });

    expect(detail(record).steps[0]?.attempts[0]?.streams).toEqual({
      stdout: "blocked\n",
      stderr: "waiting for quota\n",
    });
  });

  it("publishes detail and exitCode on a failed attempt", () => {
    const record = scriptRecord({
      streams: { stderr: "Fetch failed: HTTP 503\n" },
      detail: "the script exited 1: Fetch failed: HTTP 503",
      exitCode: 1,
    });

    const attempt = detail(record).steps[0]?.attempts[0];
    expect(attempt?.detail).toBe("the script exited 1: Fetch failed: HTTP 503");
    expect(attempt?.exitCode).toBe(1);
    expect(attempt?.streams?.stderr).toBe("Fetch failed: HTTP 503\n");
    expect(attempt?.errorCode).toBe("step_failed");
  });

  it("drops a script's projected stdout/stderr outputs while the record keeps them (FR7)", () => {
    const record = scriptRecord({
      outputs: { stdout: "blocked\n", stderr: "no quota left\n", note: "done" },
      streams: { stdout: "blocked\n", stderr: "no quota left\n" },
    });

    const pick = detail(record).steps[0];
    expect(pick?.outputs).toEqual({ note: "done" });
    expect(pick?.outputs).not.toHaveProperty("stdout");
    expect(pick?.outputs).not.toHaveProperty("stderr");
    // The record is untouched: `when` conditions still read `steps.<id>.outputs.stderr`.
    expect(record.steps["run"]?.outputs).toEqual({
      stdout: "blocked\n",
      stderr: "no quota left\n",
      note: "done",
    });
  });

  it("keeps a script's defined stdout/stderr outputs when its attempts carry no stream", () => {
    // A record written before FR2: no `streams` anywhere, so FR7 has nothing to suppress.
    const record = scriptRecord({ outputs: { stderr: "legacy\n" } });

    expect(detail(record).steps[0]?.attempts[0]).not.toHaveProperty("streams");
    expect(detail(record).steps[0]?.outputs).toEqual({ stderr: "legacy\n" });
  });

  it("stays within the public detail schema and off the list summary (G5, FR5)", () => {
    const record = scriptRecord({
      outputs: { stdout: "done\n" },
      streams: { stdout: "done\n", stderr: "warn\n" },
      exitCode: 0,
    });

    const run = detail(record);
    expect(RunDetailSchema.safeParse(run).success).toBe(true);

    const summary = toRunSummary({ taskId: "42", record });
    const listed = summary.steps[0] as unknown as Record<string, unknown>;
    expect(listed["attempts"]).toBeUndefined();
    for (const key of ["streams", "detail", "exitCode"]) {
      expect(JSON.stringify(summary)).not.toContain(`"${key}"`);
    }
  });
});

describe("toRunDetail (playbook graph, FR8)", () => {
  it("carries the graph projected from the frozen IR and never stores it", () => {
    const run = detail(settledRecord());

    expect(run.graph).toStrictEqual(buildPlaybookGraph(ir));
    expect(run.graph?.nodes.map((node) => node.id)).toStrictEqual(["pick", "ship"]);
    expect(RunDetailSchema.parse(run).graph?.edges).toStrictEqual([
      { from: "pick", to: "ship", kind: "needs" },
    ]);

    // Derived, not stored: the mirrored record and the list summary know nothing about the graph.
    expect(JSON.stringify({ taskId: "42", record: settledRecord() })).not.toContain('"graph"');
    expect(JSON.stringify(toRunSummary({ taskId: "42", record: settledRecord() }))).not.toContain(
      '"graph"',
    );
  });

  it("accepts a detail written before the field existed (additive-only contract)", () => {
    const legacy = JSON.parse(JSON.stringify(detail(settledRecord()))) as Record<string, unknown>;
    delete legacy["graph"];

    const parsed = RunDetailSchema.parse(legacy);
    expect(parsed).not.toHaveProperty("graph");
    expect(parsed.steps).toHaveLength(2);
  });

  it("memoizes the graph per frozen IR object, so a repeat projection rebuilds nothing", () => {
    const record = settledRecord();
    const first = detail(record);
    const second = detail(record);

    expect(first.graph).toBe(second.graph);
    expect(first.graph).toStrictEqual(buildPlaybookGraph(ir));

    // A record parsed from the mirror holds a fresh IR object, so the cache misses and the
    // projection is merely equal — the cache is keyed by identity, never by `ir.hash`.
    const reread = detail(settledRecord());
    expect(reread.graph).toStrictEqual(first.graph);
    expect(reread.graph).not.toBe(first.graph);
  });

  it("keeps the graph payload under 4 KB at 20 steps (NFR)", () => {
    const wide = playbook({
      id: "wide",
      steps: Array.from({ length: 20 }, (_, index) => {
        const base = {
          id: `stage-${index}`,
          title: `Stage ${index}`,
          needs: index === 0 ? [] : [`stage-${index - 1}`],
        };
        return index === 19
          ? step({
              ...base,
              outcomes: ["success", "retry"],
              on: { retry: { kind: "goto", target: "stage-0", maxLoops: 3 } },
            })
          : step(base);
      }),
    });
    const record = createRunRecord({ id: "run-wide", ir: wide, inputs: {}, cwd: "/repo", now: 1_000 });

    const run = detail(record);
    expect(run.graph?.nodes).toHaveLength(20);
    expect(run.graph?.edges.filter((edge) => edge.loop === true)).toHaveLength(1);
    expect(JSON.stringify(run.graph).length).toBeLessThan(4_096);
    expect(RunDetailSchema.safeParse(run).success).toBe(true);
  });
});
