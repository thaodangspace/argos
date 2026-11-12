import { describe, expect, it, vi } from "vitest";

import { ArgosError } from "../../src/errors.js";
import {
  dueFireTimes,
  nextFireAfter,
  parseScheduleSpec,
  type ScheduleSpec,
} from "../../src/schedule/next.js";

/**
 * The spike test set for `src/schedule/next.ts` (Phase 1, FR2.1–FR2.3, FR3.4).
 *
 * Every epoch below is derived from the documented rules — fixed-time jobs run once on a repeated
 * local time and jump to the first valid instant after a spring-forward gap; wildcard/range/step
 * jobs follow Vixie-cron — and written as a literal UTC millisecond value. Nothing here reads the
 * host clock, sleeps, or trusts the host time zone: all zones are passed explicitly.
 */

const NY = "America/New_York";
const BERLIN = "Europe/Berlin";
const SAIGON = "Asia/Saigon";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Local wall-clock rendering, used only to prove which local time an epoch is. */
const STAMP_FORMAT = new Map<string, Intl.DateTimeFormat>();

function localStamp(ms: number, tz: string): string {
  let format = STAMP_FORMAT.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    STAMP_FORMAT.set(tz, format);
  }
  const parts = format.formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")} ${hour}:${part("minute")}`;
}

function spec(cron: string, tz: string): ScheduleSpec {
  return parseScheduleSpec(cron, tz);
}

/** Run a call that must be refused, returning the `ArgosError` for message assertions. */
function refusal(run: () => unknown): ArgosError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArgosError);
    if (!(error instanceof ArgosError)) throw error;
    return error;
  }
  throw new Error("expected a refusal, but the call returned");
}

// ------------------------------------------------------------------ parser

describe("parseScheduleSpec (FR2.1, FR2.2)", () => {
  it("accepts five-field expressions and the five nicknames", () => {
    const accepted = [
      "0 7-23 * * *",
      "30 2 * * *",
      "*/5 * * * *",
      "0 0 1 1 *",
      "0 0 * * 0",
      "@hourly",
      "@daily",
      "@weekly",
      "@monthly",
      "@yearly",
    ];
    for (const cron of accepted) {
      const parsed = spec(cron, NY);
      expect(parsed.cron).toBe(cron);
      expect(parsed.tz).toBe(NY);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("trims the expression and the zone", () => {
    expect(spec("  0 0 * * *  ", "  Europe/Berlin  ")).toEqual({
      cron: "0 0 * * *",
      tz: "Europe/Berlin",
    });
  });

  it("refuses seconds fields, @reboot, other nicknames, bad syntax, and an unknown zone", () => {
    const cases: ReadonlyArray<{
      readonly what: string;
      readonly run: () => unknown;
      readonly message: RegExp;
    }> = [
      {
        what: "a six-field expression",
        run: () => parseScheduleSpec("0 0 7 * * *", "UTC"),
        message: /invalid cron expression "0 0 7 \* \* \*".*found 6/,
      },
      {
        what: "a seven-field expression",
        run: () => parseScheduleSpec("0 0 7 * * * *", "UTC"),
        message: /invalid cron expression "0 0 7 \* \* \* \*".*found 7/,
      },
      {
        what: "@reboot",
        run: () => parseScheduleSpec("@reboot", "UTC"),
        message: /invalid cron expression "@reboot".*@reboot is not supported/,
      },
      {
        what: "an unsupported nickname",
        run: () => parseScheduleSpec("@fortnightly", "UTC"),
        message: /invalid cron expression "@fortnightly".*supported nicknames/,
      },
      {
        what: "bad syntax",
        run: () => parseScheduleSpec("0 0 99 * *", "UTC"),
        message: /invalid cron expression "0 0 99 \* \*"/,
      },
      {
        what: "a zero step",
        run: () => parseScheduleSpec("*/0 * * * *", "UTC"),
        message: /invalid cron expression "\*\/0 \* \* \* \*"/,
      },
      {
        what: "an empty expression",
        run: () => parseScheduleSpec("   ", "UTC"),
        message: /invalid cron expression " +": the expression is empty/,
      },
      {
        what: "an unknown zone",
        run: () => parseScheduleSpec("0 * * * *", "Mars/Base"),
        message: /invalid time zone "Mars\/Base"/,
      },
      {
        what: "an empty zone",
        run: () => parseScheduleSpec("0 * * * *", "   "),
        message: /invalid time zone " +"/,
      },
    ];
    for (const { what, run, message } of cases) {
      const error = refusal(run);
      expect(error.code, what).toBe("invalid_request");
      expect(error.message, what).toMatch(message);
      // A stable message names the value; it is never a stack trace.
      expect(error.message, what).not.toMatch(/\n\s+at /);
    }
  });
});

// ------------------------------------------------------------------ nextFireAfter

describe("nextFireAfter (FR2.2, FR2.3)", () => {
  it("returns a time strictly after its argument, including at a fire boundary", () => {
    const hourly = spec("0 * * * *", "UTC");
    const seven = Date.UTC(2026, 0, 1, 7, 0, 0);

    expect(nextFireAfter(hourly, seven - 1)).toBe(seven);
    expect(nextFireAfter(hourly, seven)).toBe(seven + HOUR);
    expect(nextFireAfter(hourly, seven + 1)).toBe(seven + HOUR);
    expect(nextFireAfter(hourly, seven + HOUR - 1)).toBe(seven + HOUR);

    // Walking a `/7` schedule must keep advancing, never repeating or going backwards.
    const stepped = spec("*/7 * * * *", "UTC");
    let cursor = Date.UTC(2026, 4, 1, 0, 0, 0);
    for (let index = 0; index < 200; index += 1) {
      const next = nextFireAfter(stepped, cursor);
      expect(next).not.toBeNull();
      if (next === null) return;
      expect(next).toBeGreaterThan(cursor);
      expect(new Date(next).getUTCMinutes() % 7).toBe(0);
      expect(new Date(next).getUTCSeconds()).toBe(0);
      cursor = next;
    }
  });

  it("returns null, quickly, for an expression that never fires", () => {
    const never = spec("0 0 30 2 *", "UTC");
    const started = Date.now();
    expect(nextFireAfter(never, Date.UTC(2026, 0, 1))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // April 31 and February 31 are equally impossible.
    expect(nextFireAfter(spec("0 0 31 4 *", "UTC"), Date.UTC(2026, 0, 1))).toBeNull();
  });
});

// ------------------------------------------------------------------ DST table

interface DayWindow {
  readonly zone: string;
  /** The local date under test, for the assertion message only. */
  readonly day: string;
  /** The last instant of the previous local day: the window is `(from, to]`. */
  readonly from: number;
  /** The last instant of this local day. */
  readonly to: number;
  readonly expected: ReadonlyArray<{
    readonly cron: string;
    readonly count: number;
    readonly first: number;
    readonly latest: number;
  }>;
}

/**
 * Exact epoch expectations for the four transition days plus the Saigon control days. The counts
 * are the number of fire times whose local date is `day`; `first`/`latest` are the window edges.
 */
const DAY_WINDOWS: readonly DayWindow[] = [
  {
    zone: NY,
    day: "2026-03-08",
    // 00:00 EST = 05:00Z; next local midnight 2026-03-09 00:00 EDT = 04:00Z.
    from: Date.UTC(2026, 2, 8, 5) - 1,
    to: Date.UTC(2026, 2, 9, 4) - 1,
    expected: [
      // 02:30 does not exist; it fires at the first valid instant, 03:00 EDT.
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 2, 8, 7), latest: Date.UTC(2026, 2, 8, 7) },
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 2, 8, 6, 30), latest: Date.UTC(2026, 2, 8, 6, 30) },
      // 23-hour local day: 00:00, 01:00, 03:00 … 23:00.
      {
        cron: "0 * * * *",
        count: 23,
        first: Date.UTC(2026, 2, 8, 5),
        latest: Date.UTC(2026, 2, 9, 3),
      },
      {
        cron: "0 7-23 * * *",
        count: 17,
        first: Date.UTC(2026, 2, 8, 11),
        latest: Date.UTC(2026, 2, 9, 3),
      },
    ],
  },
  {
    zone: NY,
    day: "2026-11-01",
    // 00:00 EDT = 04:00Z; next local midnight 2026-11-02 00:00 EST = 05:00Z.
    from: Date.UTC(2026, 10, 1, 4) - 1,
    to: Date.UTC(2026, 10, 2, 5) - 1,
    expected: [
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 10, 1, 7, 30), latest: Date.UTC(2026, 10, 1, 7, 30) },
      // 01:30 occurs twice; a fixed-time job runs once, at the first (EDT) occurrence.
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 10, 1, 5, 30), latest: Date.UTC(2026, 10, 1, 5, 30) },
      // 25-hour local day: the 01:00 wall time fires twice.
      {
        cron: "0 * * * *",
        count: 25,
        first: Date.UTC(2026, 10, 1, 4),
        latest: Date.UTC(2026, 10, 2, 4),
      },
      {
        cron: "0 7-23 * * *",
        count: 17,
        first: Date.UTC(2026, 10, 1, 12),
        latest: Date.UTC(2026, 10, 2, 4),
      },
    ],
  },
  {
    zone: BERLIN,
    day: "2026-03-29",
    // 00:00 CET = 2026-03-28T23:00Z; next local midnight 2026-03-30 00:00 CEST = 22:00Z.
    from: Date.UTC(2026, 2, 28, 23) - 1,
    to: Date.UTC(2026, 2, 29, 22) - 1,
    expected: [
      // 02:30 does not exist; it fires at the first valid instant, 03:00 CEST.
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 2, 29, 1), latest: Date.UTC(2026, 2, 29, 1) },
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 2, 29, 0, 30), latest: Date.UTC(2026, 2, 29, 0, 30) },
      // 23-hour local day: 00:00, 01:00, 03:00 … 23:00.
      {
        cron: "0 * * * *",
        count: 23,
        first: Date.UTC(2026, 2, 28, 23),
        latest: Date.UTC(2026, 2, 29, 21),
      },
      {
        cron: "0 7-23 * * *",
        count: 17,
        first: Date.UTC(2026, 2, 29, 5),
        latest: Date.UTC(2026, 2, 29, 21),
      },
    ],
  },
  {
    zone: BERLIN,
    day: "2026-10-25",
    // 00:00 CEST = 2026-10-24T22:00Z; next local midnight 2026-10-26 00:00 CET = 23:00Z.
    from: Date.UTC(2026, 9, 24, 22) - 1,
    to: Date.UTC(2026, 9, 25, 23) - 1,
    expected: [
      // 02:30 occurs twice; a fixed-time job runs once, at the first (CEST) occurrence.
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 9, 25, 0, 30), latest: Date.UTC(2026, 9, 25, 0, 30) },
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 9, 24, 23, 30), latest: Date.UTC(2026, 9, 24, 23, 30) },
      // 25-hour local day: the 02:00 wall time fires twice.
      {
        cron: "0 * * * *",
        count: 25,
        first: Date.UTC(2026, 9, 24, 22),
        latest: Date.UTC(2026, 9, 25, 22),
      },
      {
        cron: "0 7-23 * * *",
        count: 17,
        first: Date.UTC(2026, 9, 25, 6),
        latest: Date.UTC(2026, 9, 25, 22),
      },
    ],
  },
  {
    zone: SAIGON,
    day: "2026-03-08",
    // UTC+7, no DST: 00:00 = 2026-03-07T17:00Z.
    from: Date.UTC(2026, 2, 7, 17) - 1,
    to: Date.UTC(2026, 2, 8, 17) - 1,
    expected: [
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 2, 7, 19, 30), latest: Date.UTC(2026, 2, 7, 19, 30) },
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 2, 7, 18, 30), latest: Date.UTC(2026, 2, 7, 18, 30) },
      { cron: "0 * * * *", count: 24, first: Date.UTC(2026, 2, 7, 17), latest: Date.UTC(2026, 2, 8, 16) },
      { cron: "0 7-23 * * *", count: 17, first: Date.UTC(2026, 2, 8, 0), latest: Date.UTC(2026, 2, 8, 16) },
    ],
  },
  {
    zone: SAIGON,
    day: "2026-11-01",
    from: Date.UTC(2026, 9, 31, 17) - 1,
    to: Date.UTC(2026, 10, 1, 17) - 1,
    expected: [
      { cron: "30 2 * * *", count: 1, first: Date.UTC(2026, 9, 31, 19, 30), latest: Date.UTC(2026, 9, 31, 19, 30) },
      { cron: "30 1 * * *", count: 1, first: Date.UTC(2026, 9, 31, 18, 30), latest: Date.UTC(2026, 9, 31, 18, 30) },
      { cron: "0 * * * *", count: 24, first: Date.UTC(2026, 9, 31, 17), latest: Date.UTC(2026, 10, 1, 16) },
      { cron: "0 7-23 * * *", count: 17, first: Date.UTC(2026, 10, 1, 0), latest: Date.UTC(2026, 10, 1, 16) },
    ],
  },
];

describe("DST fire times (FR2.2)", () => {
  for (const window of DAY_WINDOWS) {
    for (const expected of window.expected) {
      it(`${expected.cron} in ${window.zone} on ${window.day}`, () => {
        const due = dueFireTimes(spec(expected.cron, window.zone), window.from, window.to, 500);
        expect(due).toBeDefined();
        if (due === undefined) return;
        expect(due.capped).toBe(false);
        expect(due.count).toBe(expected.count);
        expect(due.first).toBe(expected.first);
        expect(due.latest).toBe(expected.latest);
        // The window edges really are the local day the case names.
        expect(localStamp(expected.first, window.zone).slice(0, 10)).toBe(window.day);
        expect(localStamp(expected.latest, window.zone).slice(0, 10)).toBe(window.day);
      });
    }
  }

  it("fires once at the first valid instant after the New York spring gap", () => {
    const daily = spec("30 2 * * *", NY);
    const fireAt = Date.UTC(2026, 2, 8, 7);
    expect(nextFireAfter(daily, Date.UTC(2026, 2, 8, 6, 59, 59, 999))).toBe(fireAt);
    expect(localStamp(fireAt, NY)).toBe("2026-03-08 03:00");
    // The next fire is the following day's 02:30 EDT: the skipped local time is not replayed.
    expect(nextFireAfter(daily, fireAt)).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("fires once on the repeated hour for a fixed-time job", () => {
    const newYork = spec("30 1 * * *", NY);
    const first = Date.UTC(2026, 10, 1, 5, 30);
    expect(nextFireAfter(newYork, first - 1)).toBe(first);
    expect(localStamp(first, NY)).toBe("2026-11-01 01:30");
    // 01:30 EST (06:30Z) is the second occurrence; it is not a fire time.
    expect(nextFireAfter(newYork, first)).toBe(Date.UTC(2026, 10, 2, 6, 30));

    const berlin = spec("30 2 * * *", BERLIN);
    const firstBerlin = Date.UTC(2026, 9, 25, 0, 30);
    expect(nextFireAfter(berlin, firstBerlin - 1)).toBe(firstBerlin);
    expect(localStamp(firstBerlin, BERLIN)).toBe("2026-10-25 02:30");
    // 02:30 CET (01:30Z) is the second occurrence; it is not a fire time.
    expect(nextFireAfter(berlin, firstBerlin)).toBe(Date.UTC(2026, 9, 26, 1, 30));
  });

  it("follows Vixie rules: an hourly job fires both occurrences of the repeated hour", () => {
    const hourly = spec("0 * * * *", NY);
    const first = Date.UTC(2026, 10, 1, 5);
    const second = Date.UTC(2026, 10, 1, 6);
    expect(nextFireAfter(hourly, Date.UTC(2026, 10, 1, 4, 59, 59, 999))).toBe(first);
    expect(nextFireAfter(hourly, first)).toBe(second);
    expect(nextFireAfter(hourly, second)).toBe(Date.UTC(2026, 10, 1, 7));
    expect(localStamp(first, NY)).toBe("2026-11-01 01:00");
    expect(localStamp(second, NY)).toBe("2026-11-01 01:00");

    const berlin = spec("0 * * * *", BERLIN);
    const firstBerlin = Date.UTC(2026, 9, 25, 0);
    const secondBerlin = Date.UTC(2026, 9, 25, 1);
    expect(nextFireAfter(berlin, firstBerlin - 1)).toBe(firstBerlin);
    expect(nextFireAfter(berlin, firstBerlin)).toBe(secondBerlin);
    expect(localStamp(firstBerlin, BERLIN)).toBe("2026-10-25 02:00");
    expect(localStamp(secondBerlin, BERLIN)).toBe("2026-10-25 02:00");
  });

  it("skips the nonexistent hour for a wildcard job on the spring-forward day", () => {
    const hourly = spec("0 * * * *", NY);
    const oneAm = Date.UTC(2026, 2, 8, 6);
    const threeAm = Date.UTC(2026, 2, 8, 7);
    expect(nextFireAfter(hourly, oneAm)).toBe(threeAm);
    expect(localStamp(oneAm, NY)).toBe("2026-03-08 01:00");
    expect(localStamp(threeAm, NY)).toBe("2026-03-08 03:00");
  });
});

// ------------------------------------------------------------------ dueFireTimes

describe("dueFireTimes (FR3.4)", () => {
  it("counts an hourly schedule over three days, with the window edges", () => {
    const from = Date.UTC(2026, 5, 1, 0);
    const to = from + 3 * DAY;
    const due = dueFireTimes(spec("0 * * * *", "UTC"), from, to, 1_000);
    expect(due).toEqual({
      first: from + HOUR,
      previous: from - HOUR,
      latest: to,
      beforeLatest: to - HOUR,
      count: 72,
      capped: false,
    });
  });

  it("caps at the limit for a per-minute schedule over eight days", () => {
    const from = Date.UTC(2026, 5, 1, 0);
    const to = from + 8 * DAY;
    const due = dueFireTimes(spec("* * * * *", "UTC"), from, to, 10_000);
    expect(due).toBeDefined();
    if (due === undefined) return;
    expect(due.capped).toBe(true);
    expect(due.count).toBe(10_000);
    expect(due.first).toBe(from + 60_000);
    // FR3.4: a capped window still reports the *true* last fire time, not the limit-th one, so the
    // scheduler fires the end of the outage and counts the earlier times as missed.
    expect(due.latest).toBe(to);
    expect(due.beforeLatest).toBe(to - 60_000);
    expect(due.previous).toBe(from - 60_000);
  });

  it("reports exactly-limit as not capped, and one over as capped", () => {
    const from = Date.UTC(2026, 5, 1, 0);
    const exact = dueFireTimes(spec("0 * * * *", "UTC"), from, from + 2 * HOUR, 2);
    expect(exact).toMatchObject({
      count: 2,
      capped: false,
      latest: from + 2 * HOUR,
      beforeLatest: from + HOUR,
    });
    const over = dueFireTimes(spec("0 * * * *", "UTC"), from, from + 2 * HOUR, 1);
    expect(over).toMatchObject({ count: 1, capped: true, latest: from + 2 * HOUR });
    expect(over?.beforeLatest).toBe(from + HOUR);
  });

  it("returns undefined for an empty window and for an expression that never fires", () => {
    const from = Date.UTC(2026, 5, 1, 0);
    expect(dueFireTimes(spec("0 * * * *", "UTC"), from, from, 10)).toBeUndefined();
    expect(dueFireTimes(spec("0 * * * *", "UTC"), from, from - HOUR, 10)).toBeUndefined();
    expect(dueFireTimes(spec("0 0 30 2 *", "UTC"), from, from + DAY, 10)).toBeUndefined();
  });

  it("refuses a bad limit or a non-finite window with invalid_request", () => {
    const hourly = spec("0 * * * *", "UTC");
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(refusal(() => dueFireTimes(hourly, 0, DAY, limit)).code).toBe("invalid_request");
    }
    expect(refusal(() => dueFireTimes(hourly, Number.NaN, DAY, 10)).code).toBe("invalid_request");
    expect(refusal(() => dueFireTimes(hourly, 0, Number.POSITIVE_INFINITY, 10)).code).toBe(
      "invalid_request",
    );
  });
});

// ------------------------------------------------------------------ no timers

describe("croner is a calculator, never a scheduler", () => {
  it("never calls setTimeout or setInterval from any export", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const hourly = spec("0 * * * *", "UTC");
      const from = Date.UTC(2026, 9, 31, 0);
      expect(parseScheduleSpec("@daily", BERLIN).cron).toBe("@daily");
      expect(nextFireAfter(hourly, from)).toBe(from + HOUR);
      expect(dueFireTimes(hourly, from, from + DAY, 100)?.count).toBe(24);
      // A refusal must not leak a timer either.
      expect(refusal(() => parseScheduleSpec("0 0 7 * * *", "UTC")).code).toBe("invalid_request");

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});
