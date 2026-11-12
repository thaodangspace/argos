/**
 * FR10.4: `argos serve` prints exactly one stderr line per fire outcome.
 *
 * The formatter is pure, so this test pins the shape without starting a server: the schedule id,
 * the ISO fire time, the status, and then either the run the fire started or the error code that
 * refused it. An input value never appears — the event carries none, and nothing here reads one.
 */

import { describe, expect, it } from "vitest";

import { formatScheduleFireLine, type ScheduleFireEvent } from "../src/commands/serve.js";
import { SCHEDULE_ID, SCHEDULE_SUMMARY } from "./support/fixtures.js";

const fireAt = Date.parse("2026-11-12T07:00:00.000Z");
const iso = "2026-11-12T07:00:00.000Z";

describe("argos serve fire line (FR10.4)", () => {
  it("prints the schedule, the ISO fire time, the status, and the started run", () => {
    const event: ScheduleFireEvent = {
      scheduleId: SCHEDULE_ID,
      fireAt,
      status: "started",
      runId: "01JABCDEF",
    };
    const line = formatScheduleFireLine(event);
    expect(line).toContain(event.scheduleId);
    expect(line).toContain(iso);
    expect(line).toContain("started");
    expect(line).toContain("01JABCDEF");
    expect(line).toBe(`[argos] schedule nightly ${iso} started run 01JABCDEF\n`);
  });

  it("names the error code of a refusal", () => {
    expect(
      formatScheduleFireLine({
        scheduleId: SCHEDULE_ID,
        fireAt,
        status: "refused",
        errorCode: "model_unavailable",
      }),
    ).toBe(`[argos] schedule nightly ${iso} refused model_unavailable\n`);
  });

  it("names the live run of a skipped overlap", () => {
    expect(
      formatScheduleFireLine({
        scheduleId: SCHEDULE_ID,
        fireAt,
        status: "skipped_overlap",
        runId: "run-1",
      }),
    ).toBe(`[argos] schedule nightly ${iso} skipped_overlap run run-1\n`);
  });

  it("summarizes a missed fire with its count", () => {
    expect(
      formatScheduleFireLine({ scheduleId: SCHEDULE_ID, fireAt, status: "missed", count: 3 }),
    ).toBe(`[argos] schedule nightly ${iso} missed 3\n`);
  });

  it("contains no input value", () => {
    const line = formatScheduleFireLine({
      scheduleId: SCHEDULE_ID,
      fireAt,
      status: "started",
      runId: "run-1",
    });
    for (const value of Object.values(SCHEDULE_SUMMARY.inputs)) {
      expect(line).not.toContain(String(value));
    }
    for (const name of Object.keys(SCHEDULE_SUMMARY.inputs)) {
      expect(line).not.toContain(name);
    }
  });
});
