/**
 * The gate inbox projection (inbox FR2, FR8): every pending gate of the given runs, oldest first,
 * with its run context, a clamped age, and a zone-aware open time. Pure, so the order and every label
 * are pinned without a DOM.
 */

import { describe, expect, it } from "vitest";

import type { GateSummary, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";

import { formatAge, gateInbox, type GateInboxEntry } from "./gate-inbox.js";

const NOW = 1_700_000_100_000;
const RUN_A = "01J0000000000000000000000A";
const RUN_B = "01J0000000000000000000000B";

function gate(overrides: Partial<GateSummary> = {}): GateSummary {
  return {
    runId: RUN_A,
    gateId: "ship:1",
    stepId: "ship",
    kind: "step",
    question: "Ship it?",
    choices: { approve: { label: "Approve", comment: "optional" } },
    status: "pending",
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: RUN_A,
    playbookId: "release",
    playbookHash: "h",
    status: "waiting",
    inputs: {},
    cwd: "/repo",
    steps: [],
    gates: [],
    after: [],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    seq: 1,
    ...overrides,
  };
}

function keys(entries: readonly GateInboxEntry[]): string[] {
  return entries.map((entry) => entry.key);
}

describe("gateInbox ordering", () => {
  it("puts the oldest gate first, then orders ties by run id and gate id", () => {
    const oldest = NOW - 7_200_000;
    const tie = NOW - 60_000;
    const runs = [
      run({
        id: RUN_B,
        gates: [gate({ runId: RUN_B, gateId: "fix:1", createdAt: tie })],
      }),
      run({
        id: RUN_A,
        gates: [
          gate({ runId: RUN_A, gateId: "ship:1", createdAt: tie }),
          gate({ runId: RUN_A, gateId: "add:1", createdAt: tie }),
          gate({ runId: RUN_A, gateId: "build:1", createdAt: oldest }),
        ],
      }),
    ];
    expect(keys(gateInbox(runs, { now: NOW, timeZone: "UTC" }))).toEqual([
      `${RUN_A}.build:1`,
      `${RUN_A}.add:1`,
      `${RUN_A}.ship:1`,
      `${RUN_B}.fix:1`,
    ]);
  });

  it("prefers a gate's createdAt and falls back to the run's updatedAt", () => {
    const createdAt = NOW - 3_600_000;
    const runs = [
      run({
        id: RUN_A,
        updatedAt: NOW - 1_000,
        gates: [gate({ runId: RUN_A, createdAt })],
      }),
      run({
        id: RUN_B,
        updatedAt: NOW - 7_200_000,
        gates: [gate({ runId: RUN_B, gateId: "fix:1" })],
      }),
    ];
    const entries = gateInbox(runs, { now: NOW, timeZone: "UTC" });
    expect(entries[0]?.run.id).toBe(RUN_B);
    expect(entries[0]?.waitingSince).toBe(NOW - 7_200_000);
    expect(entries[0]?.ageMs).toBe(7_200_000);
    expect(entries[1]?.waitingSince).toBe(createdAt);
    expect(entries[1]?.ageMs).toBe(3_600_000);
  });

  it("only includes pending gates", () => {
    const runs = [
      run({
        gates: [
          gate({ gateId: "ship:1" }),
          gate({ gateId: "ship:2", status: "decided", decision: "approve", createdAt: NOW - 60_000 }),
        ],
      }),
    ];
    expect(keys(gateInbox(runs, { now: NOW, timeZone: "UTC" }))).toEqual([`${RUN_A}.ship:1`]);
  });

  it("returns no entries for an empty input", () => {
    expect(gateInbox([], { now: NOW, timeZone: "UTC" })).toEqual([]);
    expect(gateInbox([run()], { now: NOW, timeZone: "UTC" })).toEqual([]);
  });
});

describe("gateInbox age", () => {
  it("clamps a future or non-finite instant to zero", () => {
    const runs = [
      run({ id: RUN_A, gates: [gate({ runId: RUN_A, createdAt: NOW + 60_000 })] }),
      run({
        id: RUN_B,
        gates: [gate({ runId: RUN_B, gateId: "fix:1", createdAt: Number.NaN })],
      }),
    ];
    const entries = gateInbox(runs, { now: NOW, timeZone: "UTC" });
    for (const entry of entries) {
      expect(entry.ageMs).toBe(0);
      expect(entry.ageLabel).toBe("0s");
    }
    expect(entries[0]?.sinceLabel).toBe("2023-11-14 22:16 UTC");
    // An instant `Intl` cannot format has no absolute label, but it still renders a card.
    expect(entries[1]?.sinceLabel).toBe("");
  });

  it("formats an age in at most two units, with days above a day", () => {
    expect(formatAge(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatAge(86_400_000)).toBe("1d");
    expect(formatAge(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
    expect(formatAge(2 * 60_000)).toBe("2m");
    expect(formatAge(2 * 60_000 + 5_000)).toBe("2m 5s");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(0)).toBe("0s");
  });

  it("never prints a negative or non-finite age", () => {
    expect(formatAge(-1)).toBe("0s");
    expect(formatAge(Number.NaN)).toBe("0s");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("gateInbox run join", () => {
  it("fills the run context of every entry", () => {
    const runs = [
      run({
        id: RUN_A,
        playbookId: "release",
        cwd: "/Users/dt/code/vsee",
        status: "waiting",
        executor: "hc",
        gates: [gate({ runId: RUN_A, stepId: "ship" })],
      }),
      run({
        id: RUN_B,
        playbookId: "nightly",
        cwd: "/repo/argos",
        status: "running",
        trigger: { kind: "schedule", scheduleId: "nightly", fireAt: NOW - 60_000, reason: "cron" },
        gates: [gate({ runId: RUN_B, gateId: "fix:1", stepId: "review" })],
      }),
    ];
    const entries = gateInbox(runs, { now: NOW, timeZone: "UTC" });
    expect(entries.map((entry) => entry.key)).toEqual([`${RUN_A}.ship:1`, `${RUN_B}.fix:1`]);

    const first = entries[0];
    expect(first?.gate).toMatchObject({ runId: RUN_A, gateId: "ship:1", deciding: false });
    expect(first?.run).toEqual({
      id: RUN_A,
      playbookId: "release",
      project: "vsee",
      status: "waiting",
      triggerFacet: "manual",
      executor: "hc",
      stepId: "ship",
    });
    expect(first?.waitingSince).toBe(NOW - 60_000);
    expect(first?.ageLabel).toBe("1m");
    expect(first?.sinceLabel).toBe("2023-11-14 22:14 UTC");

    const second = entries[1];
    expect(second?.run).toMatchObject({
      triggerFacet: "schedule",
      executor: "paseo",
      project: "argos",
      stepId: "review",
    });
  });

  it("reports a fork as its own trigger facet", () => {
    const runs = [
      run({
        forkedFrom: { runId: "01J0000000000000000000000C", stepId: "ship", fromHash: "a", toHash: "b" },
        gates: [gate()],
      }),
    ];
    const entry = gateInbox(runs, { now: NOW, timeZone: "UTC" })[0];
    expect(entry?.run.triggerFacet).toBe("fork");
  });

  it("keeps two runs that share a gateId apart", () => {
    const runs = [
      run({ id: RUN_A, gates: [gate({ runId: RUN_A, gateId: "fix:1" })] }),
      run({ id: RUN_B, gates: [gate({ runId: RUN_B, gateId: "fix:1" })] }),
    ];
    const entries = gateInbox(runs, { now: NOW, timeZone: "UTC" });
    expect(keys(entries)).toEqual([`${RUN_A}.fix:1`, `${RUN_B}.fix:1`]);
    expect(new Set(keys(entries)).size).toBe(2);
  });
});

describe("gateInbox deciding", () => {
  it("marks only the entry whose key is in flight", () => {
    const runs = [
      run({
        id: RUN_A,
        gates: [gate({ runId: RUN_A, gateId: "ship:1" }), gate({ runId: RUN_A, gateId: "fix:1" })],
      }),
      run({ id: RUN_B, gates: [gate({ runId: RUN_B, gateId: "fix:1" })] }),
    ];
    const entries = gateInbox(runs, {
      now: NOW,
      timeZone: "UTC",
      deciding: [`${RUN_A}.ship:1`],
    });
    expect(entries.map((entry) => [entry.key, entry.gate.deciding])).toEqual([
      [`${RUN_A}.fix:1`, false],
      [`${RUN_A}.ship:1`, true],
      [`${RUN_B}.fix:1`, false],
    ]);
  });
});

describe("gateInbox labels", () => {
  it("follows the reader's zone for the open time and never for the age", () => {
    const waitingSince = 1_700_000_000_000;
    const runs = [run({ id: RUN_A, gates: [gate({ runId: RUN_A, createdAt: waitingSince })] })];
    const utc = gateInbox(runs, { now: waitingSince + 120_000, timeZone: "UTC" })[0];
    const saigon = gateInbox(runs, { now: waitingSince + 120_000, timeZone: "Asia/Saigon" })[0];
    expect(utc?.sinceLabel).toBe("2023-11-14 22:13 UTC");
    expect(saigon?.sinceLabel).toBe("2023-11-15 05:13 +07:00");
    expect(utc?.ageLabel).toBe("2m");
    expect(saigon?.ageLabel).toBe("2m");
  });
});
