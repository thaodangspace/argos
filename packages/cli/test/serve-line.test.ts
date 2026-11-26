/**
 * FR10.4: `argos serve` prints exactly one stderr line per fire outcome.
 *
 * The formatter is pure, so this test pins the shape without starting a server: the schedule id,
 * the ISO fire time, the status, and then either the run the fire started or the error code that
 * refused it. An input value never appears — the event carries none, and nothing here reads one.
 */

import { describe, expect, it } from "vitest";

import { formatExecutorLine, formatScheduleFireLine, resolveDefaultExecutor, type ScheduleFireEvent } from "../src/commands/serve.js";
import { runCli } from "../src/main.js";
import { capture, makeTempHome, withEnv } from "./support/cli.js";
import { HC_EXECUTOR, PASEO_EXECUTOR, SCHEDULE_ID, SCHEDULE_SUMMARY } from "./support/fixtures.js";

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

describe("argos serve executor startup (FR9, FR16)", () => {
  it("prints one line naming the registry and the default", () => {
    // Registry order is `hc` first (FR1), so the line reads the same way a fresh server prints it.
    expect(formatExecutorLine([HC_EXECUTOR, PASEO_EXECUTOR])).toBe(
      "[argos] executors: hc, paseo (default)\n",
    );
    // The default is whatever the server resolved, never hard-coded to paseo.
    expect(
      formatExecutorLine([{ ...HC_EXECUTOR, default: true }, { ...PASEO_EXECUTOR, default: false }]),
    ).toBe("[argos] executors: hc (default), paseo\n");
    expect(formatExecutorLine([])).toBe("[argos] executors: (none)\n");
  });

  it("prefers hc, falls back to paseo, and never rewrites an operator's choice", () => {
    // No flag/env: `hc` is the preferred substrate once its adapter registered...
    expect(resolveDefaultExecutor(undefined, true)).toBe("hc");
    // ...and a server whose core probe failed starts on the entry the registry always carries.
    expect(resolveDefaultExecutor(undefined, false)).toBe("paseo");
    // An explicit choice is returned verbatim: `ArgosHost.open` refuses an unregistered one.
    expect(resolveDefaultExecutor("paseo", true)).toBe("paseo");
    expect(resolveDefaultExecutor("hc", false)).toBe("hc");
  });

  it("refuses an unknown --default-executor before opening anything", async () => {
    const home = makeTempHome();
    const restore = withEnv({ ARGOS_HOME: home.home, ARGOS_FAKE_PASEO: "1" });
    try {
      const captured = capture();
      const code = await runCli(
        ["serve", "--default-executor", "nope", "--json", "--home", home.home],
        captured.io,
      );
      expect(code).toBe(1);
      expect(captured.stderr()).toContain("--default-executor");
      expect(captured.stderr()).toContain("hc, paseo");
      // Nothing was served, so stdout stayed empty.
      expect(captured.stdout()).toBe("");
    } finally {
      restore();
      home.cleanup();
    }
  });

  it("refuses a known executor this build does not register", async () => {
    const home = makeTempHome();
    const restore = withEnv({ ARGOS_HOME: home.home, ARGOS_FAKE_PASEO: "1" });
    try {
      const captured = capture();
      // Only `paseo` is registered in this phase; `hc` arrives with its adapter (Phase 7).
      const code = await runCli(
        ["serve", "--default-executor", "hc", "--json", "--home", home.home],
        captured.io,
      );
      expect(code).toBe(1);
      expect(captured.stderr()).toContain("executor_unavailable");
      expect(captured.stderr()).toContain("default executor");
      expect(captured.stderr()).toContain("registered executors: paseo");
      expect(captured.stdout()).toBe("");
    } finally {
      restore();
      home.cleanup();
    }
  });
});
