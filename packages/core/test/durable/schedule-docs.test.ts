/**
 * Phase 4 verification: the schedule documents (FR1.1, FR1.4, FR4.3, and the bounded-document NFR).
 *
 * The pure helpers are tested here on their own — hydration strictness, the two caps, and the message
 * bound — because a failure in any of them would silently corrupt a schedule instead of failing a
 * fire. The document lifecycle (add/edit/pause/resume/remove) lives in `schedules.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { isArgosError } from "../../src/errors.js";
import {
  FIRE_LOG_LIMIT,
  RUN_IDS_LIMIT,
} from "../../src/schedule/model.js";
import {
  boundMessage,
  hydrateScheduleDoc,
  pushFire,
  pushRunId,
  scheduleDocSeed,
  toScheduleDoc,
  toScheduleDocValue,
  type FireEntry,
  type ScheduleDoc,
  type ScheduleDocValue,
} from "../../src/durable/schedule-docs.js";

function sampleDoc(overrides: Partial<ScheduleDoc> = {}): ScheduleDoc {
  return {
    id: "nightly",
    uid: "01J8ZQ00000000000000000000",
    playbookId: "nightly",
    cwd: "/tmp/repo",
    inputs: { count: 1, flag: true, label: "x" },
    isolation: "none",
    cron: "0 7 * * *",
    tz: "UTC",
    overlap: "skip",
    catchUp: "all",
    keep: 30,
    enabled: true,
    generation: 3,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    nextFireAt: 1_760_004_000_000,
    lastFire: {
      fireAt: 1_760_000_000_000,
      at: 1_760_000_000_100,
      reason: "cron",
      status: "started",
      runId: "01J8ZQ0000000000000000000A",
    },
    liveRunId: "01J8ZQ0000000000000000000A",
    runIds: ["01J8ZQ0000000000000000000A"],
    fires: [],
    consecutiveFailures: 0,
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isArgosError(error) ? error.code : `<not an ArgosError: ${String(error)}>`;
  }
  return "<did not throw>";
}

function fireAt(index: number): FireEntry {
  return { fireAt: index, at: index + 1, reason: "cron", status: "started", runId: `run-${index}` };
}

describe("schedule documents (FR1.1/FR1.4)", () => {
  it("round-trips a document through the null-placeholder storage value", () => {
    const doc = sampleDoc();
    const value = toScheduleDocValue(doc);
    // Strict JSON: every optional field exists, and the absent ones are `null`.
    expect(value.isolation).toBe("none");
    expect(value.runIds).toEqual(["01J8ZQ0000000000000000000A"]);
    expect(toScheduleDoc(value)).toEqual(doc);
    expect(toScheduleDocValue(toScheduleDoc(value))).toEqual(value);

    // A document with no optional field holds `null` in storage and no key in the typed shape.
    const { isolation, lastFire, liveRunId, ...required } = sampleDoc();
    expect(isolation).toBe("none");
    const bare: ScheduleDoc = required;
    const bareValue = toScheduleDocValue(bare);
    expect(bareValue.isolation).toBeNull();
    expect(bareValue.lastFire).toBeNull();
    expect(bareValue.liveRunId).toBeNull();
    expect(toScheduleDoc(bareValue)).toEqual(bare);
  });

  it("hydrates a stored value and drops the null placeholders", () => {
    const value = toScheduleDocValue(sampleDoc());
    const doc = hydrateScheduleDoc(value);
    expect(doc.id).toBe("nightly");
    expect(doc.lastFire?.runId).toBe("01J8ZQ0000000000000000000A");
    expect("isolation" in doc).toBe(true);
  });

  it("refuses an unknown key instead of silently dropping it", () => {
    const value = { ...toScheduleDocValue(sampleDoc()), surprise: "hand-edited" };
    expect(codeOf(() => hydrateScheduleDoc(value))).toBe("invalid_request");

    const nested: ScheduleDocValue = {
      ...toScheduleDocValue(sampleDoc()),
      fires: [
        {
          fireAt: 1,
          at: 2,
          reason: "cron",
          status: "started",
          runId: "r",
          errorCode: null,
          message: null,
          count: null,
          from: null,
          to: null,
          injected: true,
        } as never,
      ],
    };
    expect(codeOf(() => hydrateScheduleDoc(nested))).toBe("invalid_request");
  });

  it("refuses a stored value of the wrong shape", () => {
    const base = toScheduleDocValue(sampleDoc());
    const cases: unknown[] = [
      { ...base, enabled: "yes" },
      { ...base, overlap: "queue_one" },
      { ...base, nextFireAt: "soon" },
      { ...base, keep: 0 },
      { ...base, catchUp: -1 },
      { ...base, id: "Not An Id" },
      { ...base, runIds: [1] },
      { ...base, fires: "none" },
      { ...base, generation: 1.5 },
      null,
      "schedule",
    ];
    for (const value of cases) {
      expect(codeOf(() => hydrateScheduleDoc(value)), JSON.stringify(value)).toBe(
        "invalid_request",
      );
    }
  });

  it("hydrates the empty creation seed (a first read must not throw)", () => {
    const seed = scheduleDocSeed("nightly");
    expect(hydrateScheduleDoc(seed).id).toBe("nightly");
  });

  it("keeps the fire log newest-first and capped (NFR)", () => {
    const fires: FireEntry[] = [];
    for (let index = 0; index < FIRE_LOG_LIMIT + 10; index += 1) pushFire(fires, fireAt(index));
    expect(fires).toHaveLength(FIRE_LOG_LIMIT);
    expect(fires[0]?.fireAt).toBe(FIRE_LOG_LIMIT + 9);
    expect(fires[FIRE_LOG_LIMIT - 1]?.fireAt).toBe(10);
  });

  it("keeps runIds newest-first, unique, and capped (FR9.2)", () => {
    const runIds: string[] = [];
    for (let index = 0; index < RUN_IDS_LIMIT + 5; index += 1) pushRunId(runIds, `run-${index}`);
    expect(runIds).toHaveLength(RUN_IDS_LIMIT);
    expect(runIds[0]).toBe(`run-${RUN_IDS_LIMIT + 4}`);
    expect(runIds[RUN_IDS_LIMIT - 1]).toBe("run-5");

    // A repeated id moves to the front instead of appearing twice or growing the list.
    pushRunId(runIds, "run-10");
    expect(runIds).toHaveLength(RUN_IDS_LIMIT);
    expect(runIds[0]).toBe("run-10");
    expect(runIds.filter((id) => id === "run-10")).toHaveLength(1);
  });

  it("cuts a stored message at 500 characters (FR6.2)", () => {
    expect(boundMessage("short")).toBe("short");
    expect(boundMessage("x".repeat(600))).toHaveLength(500);
    expect(boundMessage("x".repeat(500))).toHaveLength(500);
  });
});
