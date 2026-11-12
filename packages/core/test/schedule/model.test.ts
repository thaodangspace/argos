/**
 * Phase 4 verification: the schedule model (FR1.2, FR3.5, FR9.1).
 *
 * These are the pure pieces — the id pattern and the two caller-value normalizers — so they need no
 * host, no storage, and no clock. Everything else about a schedule is checked by
 * `test/durable/schedules.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { isArgosError } from "../../src/errors.js";
import {
  FIRE_LOG_LIMIT,
  KEEP_DEFAULT,
  LATE_TOLERANCE_MS,
  MISSED_COUNT_LIMIT,
  RUN_IDS_LIMIT,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_LIMIT,
  TIMER_MAX_MS,
  normalizeCatchUp,
  normalizeKeep,
} from "../../src/schedule/model.js";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isArgosError(error) ? error.code : `<not an ArgosError: ${String(error)}>`;
  }
  return "<did not throw>";
}

describe("schedule model (FR1.2/FR3.5/FR9.1)", () => {
  it("keeps the spec's bounds", () => {
    expect(SCHEDULE_LIMIT).toBe(100);
    expect(FIRE_LOG_LIMIT).toBe(50);
    expect(RUN_IDS_LIMIT).toBe(1_000);
    expect(KEEP_DEFAULT).toBe(30);
    expect(LATE_TOLERANCE_MS).toBe(120_000);
    expect(MISSED_COUNT_LIMIT).toBe(10_000);
    expect(TIMER_MAX_MS).toBe(60_000);
  });

  it("accepts the documented schedule ids and refuses everything else (FR1.2)", () => {
    for (const id of ["a", "nightly", "va-dev-sync", "0hourly", `a${"b".repeat(63)}`]) {
      expect(SCHEDULE_ID_PATTERN.test(id), id).toBe(true);
    }
    for (const id of ["", "-a", "A", "a_b", "a.b", "with space", `a${"b".repeat(64)}`]) {
      expect(SCHEDULE_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("normalizes catchUp to milliseconds (FR3.5)", () => {
    expect(normalizeCatchUp("all")).toBe("all");
    expect(normalizeCatchUp(0)).toBe(0);
    expect(normalizeCatchUp(90_000)).toBe(90_000);
    expect(normalizeCatchUp("90m")).toBe(5_400_000);
    expect(normalizeCatchUp("30s")).toBe(30_000);
    expect(normalizeCatchUp("12h")).toBe(43_200_000);
    expect(normalizeCatchUp("2d")).toBe(172_800_000);
    expect(normalizeCatchUp("0m")).toBe(0);
  });

  it("refuses an unsupported or malformed catchUp with invalid_request (FR3.5)", () => {
    for (const value of ["1w", "-1", "-1m", "1.5h", "", "soon", "m", "90 m", 1.5, -1, Number.NaN]) {
      expect(codeOf(() => normalizeCatchUp(value)), JSON.stringify(value)).toBe("invalid_request");
    }
  });

  it("keeps 1..1000 or all (FR9.1)", () => {
    expect(normalizeKeep("all")).toBe("all");
    expect(normalizeKeep(1)).toBe(1);
    expect(normalizeKeep(1_000)).toBe(1_000);
    expect(normalizeKeep(KEEP_DEFAULT)).toBe(KEEP_DEFAULT);
  });

  it("refuses a keep outside 1..1000 with invalid_request (FR9.1)", () => {
    for (const value of [0, 1_001, -5, 2.5, Number.NaN, "30"]) {
      expect(codeOf(() => normalizeKeep(value as never)), JSON.stringify(value)).toBe(
        "invalid_request",
      );
    }
  });
});
