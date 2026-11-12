/**
 * The pure next-fire calculator (FR2.1–FR2.3, FR3.4): the only module that imports `croner`.
 *
 * `croner` is used as a **calculator**, never as a scheduler. Every instance is built with
 * `paused: true` and without a callback, so its constructor never calls `schedule()` and no timer
 * (Node or otherwise) is ever armed here. The durable scheduler in `src/durable/schedules.ts`
 * owns the only timer Argos arms.
 *
 * This module sits outside `src/engine/` on purpose: `engine/purity.test.ts` bans `Date`, and a
 * calendar calculation needs it. It is still pure — no timers, no module-level clock read, and
 * every result is a plain number derived from the arguments — so the fixed-epoch tests in
 * `test/schedule/next.test.ts` are the whole truth about its behaviour.
 *
 * DST follows the rules the spec records (and `croner` documents): a *fixed-time* job (single
 * minute, hour, and second, no wildcard or step) runs once on a repeated local time and, when its
 * local time falls in a spring-forward gap, at the first valid instant after the gap. A wildcard,
 * range, or step job follows Vixie-cron: it runs on both occurrences of a repeated local time and
 * skips a nonexistent one. `test/schedule/next.test.ts` pins both behaviours with exact epochs for
 * America/New_York, Europe/Berlin, and Asia/Saigon.
 */

import { Cron } from "croner";

import { ArgosError } from "../errors.js";

/** A validated cron expression plus the IANA zone it is read in. */
export interface ScheduleSpec {
  readonly cron: string;
  readonly tz: string;
}

/**
 * The supported `@` nicknames (FR2.1). The upstream library also knows `@annually` and
 * `@midnight`; the contract here is exactly these five, so a caller cannot half-learn the set.
 */
const NICKNAMES: ReadonlySet<string> = new Set(["@hourly", "@daily", "@weekly", "@monthly", "@yearly"]);

/** The five-field layout Argos stores. Seconds-level expressions are out of scope. */
const FIELD_COUNT = 5;

/** `(fromMs, toMs]` fire times, with the count capped at the caller's limit. */
export interface DueFireTimes {
  /** The first fire time inside the window. */
  readonly first: number;
  /** The last fire time strictly before `fromMs`, when the expression has one. */
  readonly previous?: number;
  /**
   * The **true** last fire time inside the window, even when {@link capped} is true (the truncated
   * forward walk stops at `count`, so the tail comes from a backwards search).
   */
  readonly latest: number;
  /**
   * The fire time strictly before {@link latest}, when the calendar has one. A caller that fires
   * {@link latest} renders the earlier due times as a missed range ending here (FR3.6).
   */
  readonly beforeLatest?: number;
  /** Fire times inside the window, or `limit` when {@link capped} is true. */
  readonly count: number;
  /** True when the window holds more than `limit` fire times. */
  readonly capped: boolean;
}

// ------------------------------------------------------------------ validation

function invalidCron(cron: string, detail: string, cause?: unknown): ArgosError {
  const message = `invalid cron expression ${JSON.stringify(cron)}: ${detail}`;
  const details = cause === undefined ? {} : { cause };
  return new ArgosError("invalid_request", message, details);
}

function invalidTz(tz: string, cause?: unknown): ArgosError {
  const message = `invalid time zone ${JSON.stringify(tz)}: expected an IANA zone name Intl accepts`;
  return new ArgosError("invalid_request", message, cause === undefined ? {} : { cause });
}

/**
 * Build the paused calculator for a spec. `mode: "5-part"` keeps the seconds field at zero and
 * makes a six-field pattern fail here as well, in addition to the field count in
 * {@link parseScheduleSpec}.
 */
function compile(spec: ScheduleSpec): Cron {
  try {
    // `paused: true` plus the absent callback: the constructor never reaches `schedule()`, so no
    // timer is armed. This is the spike's "croner never arms its own timer" guarantee.
    return new Cron(spec.cron, { timezone: spec.tz, mode: "5-part", paused: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the expression could not be parsed";
    throw invalidCron(spec.cron, reason, error);
  }
}

/**
 * Validate a cron expression and its zone (FR2.1, FR2.2).
 *
 * Accepts exactly five whitespace-separated fields or one of the five nicknames. A six- or
 * seven-field (seconds) pattern, `@reboot`, and any other nickname are refused, as are bad syntax
 * and a zone `Intl` rejects. Every refusal is `invalid_request` naming the cron expression or the
 * zone; the message never carries a stack.
 */
export function parseScheduleSpec(cron: string, tz: string): ScheduleSpec {
  const expression = typeof cron === "string" ? cron.trim() : "";
  if (expression === "") throw invalidCron(String(cron), "the expression is empty");

  if (expression.startsWith("@")) {
    const nickname = expression.toLowerCase();
    if (nickname === "@reboot") {
      throw invalidCron(expression, "@reboot is not supported: Argos fires on a wall clock, not on process start");
    }
    if (!NICKNAMES.has(nickname)) {
      throw invalidCron(expression, "supported nicknames are @hourly, @daily, @weekly, @monthly, and @yearly");
    }
  } else {
    const fields = expression.split(/\s+/);
    if (fields.length !== FIELD_COUNT) {
      throw invalidCron(
        expression,
        `expected ${FIELD_COUNT} whitespace-separated fields (minute hour day-of-month month day-of-week), found ${fields.length}`,
      );
    }
  }

  if (typeof tz !== "string" || tz.trim() === "") {
    throw invalidTz(String(tz));
  }
  const zone = tz.trim();
  try {
    // The only tz check: an unknown zone (`Mars/Base`) throws `RangeError` here. The string never
    // reaches a shell or a date parser other than `Intl`.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch (error) {
    throw invalidTz(zone, error);
  }

  // Fail now, not on the first fire: this parses the expression (and the zone a second time).
  compile({ cron: expression, tz: zone });

  return Object.freeze({ cron: expression, tz: zone });
}

// ------------------------------------------------------------------ computation

/**
 * The first fire time strictly after `afterMs`, or `null` when the expression never fires (for
 * example `0 0 30 2 *`).
 *
 * The search is bounded by the library's own walk (it stops after the covered year range and
 * answers `null`), so a never-matching date cannot loop forever; the spike measured the
 * impossible-date case at a few milliseconds.
 */
export function nextFireAfter(spec: ScheduleSpec, afterMs: number): number | null {
  if (!Number.isFinite(afterMs)) {
    throw new ArgosError("invalid_request", "nextFireAfter needs a finite epoch-millisecond argument");
  }
  const job = compile(spec);
  const next = job.nextRun(new Date(afterMs));
  if (next === null) return null;
  const fireAt = next.getTime();
  // Defensive: croner promises a strictly later time; refuse to return anything else.
  return Number.isFinite(fireAt) && fireAt > afterMs ? fireAt : null;
}

/**
 * Every fire time in `(fromMs, toMs]`, counted up to `limit` (FR3.4).
 *
 * Returns `undefined` for an empty or inverted window and for an expression that never fires.
 * `count` is the number of fire times found, or `limit` when there are more; `capped` says which.
 * `first` and `latest` are the window edges; `previous` is the last fire time strictly before
 * `fromMs`, which is what a missed-fire log renders as the start of the gap.
 *
 * `latest` is always the *real* last fire time of the window, capped or not: the scheduler fires it
 * and counts the earlier ones, so reporting the limit-th time for a long outage would start the run
 * that belongs at the end of the outage (FR3.4, G4). `beforeLatest` is the fire time just before it,
 * which is where the missed range ends when `latest` fires (FR3.6).
 *
 * The loop is bounded by `limit + 1` results, so neither a wide window nor a per-minute
 * expression can make it unbounded work.
 */
export function dueFireTimes(
  spec: ScheduleSpec,
  fromMs: number,
  toMs: number,
  limit: number,
): DueFireTimes | undefined {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ArgosError("invalid_request", "dueFireTimes needs a positive integer limit");
  }
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new ArgosError("invalid_request", "dueFireTimes needs a finite epoch-millisecond window");
  }
  if (toMs <= fromMs) return undefined;

  const job = compile(spec);
  // One extra result distinguishes "exactly limit" (not capped) from "more than limit".
  const candidates = job.nextRuns(limit + 1, new Date(fromMs));
  const fireTimes: number[] = [];
  for (const candidate of candidates) {
    const fireAt = candidate.getTime();
    if (fireAt > toMs) break;
    fireTimes.push(fireAt);
  }

  const capped = fireTimes.length > limit;
  // When capped, the extra probe result is not part of the window report.
  const counted = capped ? fireTimes.slice(0, limit) : fireTimes;
  const first = counted[0];
  if (first === undefined) return undefined;

  // `previousRuns` is exclusive with one-second granularity, so the inclusive tail needs the helper
  // below; the non-capped case already knows the last collected fire time exactly.
  let latest: number;
  let beforeLatest: number | undefined;
  if (capped) {
    const tail = lastFireAtOrBefore(job, toMs);
    if (tail === undefined) return undefined;
    latest = tail;
    beforeLatest = lastFireAtOrBefore(job, latest - 1);
  } else {
    const last = counted[counted.length - 1];
    if (last === undefined) return undefined;
    latest = last;
    beforeLatest = counted[counted.length - 2];
  }

  const previousRun = job.previousRuns(1, new Date(fromMs))[0];
  const previous = previousRun === undefined ? undefined : previousRun.getTime();

  return Object.freeze({
    first,
    ...(previous === undefined ? {} : { previous }),
    latest,
    ...(beforeLatest === undefined ? {} : { beforeLatest }),
    count: counted.length,
    capped,
  });
}

/** One second: `previousRuns` excludes fire times inside the same second as its argument. */
const SECOND_MS = 1_000;

/**
 * The greatest fire time `<= atMs`.
 *
 * `croner.previousRuns()` answers "the run before this instant" and is exclusive with one-second
 * granularity: a probe at a fire time returns the *previous* one. Probing one second later and
 * stepping back while the answer is still after `atMs` gives the inclusive result without depending
 * on that off-by-one detail, and the loop terminates because every step moves at least a second
 * back (the supported expressions fire at most once a minute).
 */
function lastFireAtOrBefore(job: Cron, atMs: number): number | undefined {
  let run = job.previousRuns(1, new Date(atMs + SECOND_MS))[0];
  while (run !== undefined && run.getTime() > atMs) {
    run = job.previousRuns(1, new Date(run.getTime()))[0];
  }
  return run === undefined ? undefined : run.getTime();
}
