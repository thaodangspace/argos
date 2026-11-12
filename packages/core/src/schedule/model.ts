/**
 * The schedule model (FR1.2, FR1.4, FR3.5, FR9.1): ids, bounds, and the zod schemas every surface
 * shares.
 *
 * This module imports **only** `zod` and the error type. `croner` — the one dependency a cron
 * expression needs — lives in `src/schedule/next.ts`, so `rpc/contracts.ts` can import these
 * schemas without pulling a scheduler (or a timer) into the CLI and the Paseo plugin, which bundle
 * the RPC contract but must never arm a timer.
 *
 * The defaults are the spec's: 50 fire-log entries, 1,000 run ids, 100 schedules, 30 kept runs, and
 * a two-minute tolerance that separates a `cron` fire from a `catch_up` one.
 */

import { z } from "zod";

import { ArgosError } from "../errors.js";

// ------------------------------------------------------------------ constants

/**
 * FR1.2: the schedule id alphabet. It is DNS-label-shaped because it is also used as the family key
 * of `argos.schedule` and as the `--schedule` filter value, so no escaping is ever needed.
 */
export const SCHEDULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** FR1.5: at most this many schedules, so `argos schedule ls` and one tick stay bounded. */
export const SCHEDULE_LIMIT = 100;

/** NFR: the fire log keeps the newest entries; the document stays small forever. */
export const FIRE_LOG_LIMIT = 50;

/** FR9.2: `runIds` is capped (newest first); an id dropped by the cap is no longer pruned. */
export const RUN_IDS_LIMIT = 1_000;

/** FR9.1: the default retention: how many finished runs of one schedule are kept. */
export const KEEP_DEFAULT = 30;

/** FR3.5/FR3.7: a fire at most this late still runs as `cron`; later than this it is `catch_up`. */
export const LATE_TOLERANCE_MS = 120_000;

/** FR3.4: missed fire times are counted up to this many; above that the log says `10000+`. */
export const MISSED_COUNT_LIMIT = 10_000;

/** FR3.1: the timer never sleeps longer than this, so a laptop waking from sleep notices. */
export const TIMER_MAX_MS = 60_000;

/** The overflow marker a missed-fire entry carries once the count passes the limit (FR3.4). */
export const MISSED_COUNT_OVERFLOW = "10000+";

/** A scalar schedule input value: the same shapes a playbook input accepts (FR7). */
export const ScalarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// ------------------------------------------------------------------ schemas

/** FR5.1: what to do when a fire comes due while the previous run still works. */
export const OverlapSchema = z.enum(["skip", "allow"]);
export type Overlap = z.infer<typeof OverlapSchema>;

/** The outcome of one fire attempt, as recorded in `lastFire` and the fire log (FR6.1). */
export const FireStatusSchema = z.enum(["started", "skipped_overlap", "refused", "missed"]);
export type FireStatus = z.infer<typeof FireStatusSchema>;

/** Why a fire happened (FR3.7, FR7.6). */
export const FireReasonSchema = z.enum(["cron", "catch_up", "run_now"]);
export type FireReason = z.infer<typeof FireReasonSchema>;

/** FR3.5: `"all"` always fires the latest due time; a number is a late window in milliseconds. */
export const CatchUpSchema = z.union([z.literal("all"), z.number().int().min(0)]);
export type CatchUp = z.infer<typeof CatchUpSchema>;

const DURATION_UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION_PATTERN = /^([0-9]+)([smhd])$/;

/**
 * What a caller may send for `catchUp`: the stored shape plus the CLI shorthand `<n><unit>`
 * (`90m`, `12h`, `2d`). `"1w"`, a negative number, and a float are refused by
 * {@link normalizeCatchUp} with `invalid_request` (FR1.2-style caller validation).
 */
export const CatchUpInputSchema = z.union([
  z.literal("all"),
  z.number(),
  z.string(),
]);
export type CatchUpInput = z.infer<typeof CatchUpInputSchema>;

/** FR9.1: `"all"` keeps every run; a number is 1..1,000. */
export const KeepSchema = z.union([z.literal("all"), z.number().int().min(1).max(1_000)]);
export type Keep = z.infer<typeof KeepSchema>;
export type KeepInput = Keep;

/**
 * One fire outcome (FR1.4 technical data model). `runId` is set for `started` and
 * `skipped_overlap`, `errorCode`/`message` for `refused`, and `count`/`from`/`to` for the single
 * `missed` entry a late tick writes. A field that does not apply is absent from this typed shape;
 * the stored value keeps it as `null` so the document is strict JSON (see `durable/schedule-docs.ts`).
 */
export const FireEntrySchema = z.strictObject({
  fireAt: z.number(),
  at: z.number(),
  reason: FireReasonSchema,
  status: FireStatusSchema,
  runId: z.string().optional(),
  errorCode: z.string().nullable().optional(),
  message: z.string().optional(),
  count: z.union([z.number().int(), z.literal(MISSED_COUNT_OVERFLOW)]).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});

// ------------------------------------------------------------------ normalization

function invalidCatchUp(value: unknown): ArgosError {
  return new ArgosError(
    "invalid_request",
    `catchUp ${JSON.stringify(value)} is invalid: use "all", a non-negative whole number of milliseconds, or a duration such as "90m"`,
  );
}

/**
 * FR3.5: normalize a caller's catch-up value to the stored shape.
 *
 * `"all"` stays `"all"`, a non-negative integer stays itself, and `<n><unit>` becomes milliseconds
 * (`90m` → 5,400,000). Everything else — `-1`, `1.5`, `"1w"`, `"soon"`, an empty string — is
 * `invalid_request`: the CLI and RPC pass values through unchanged, so this is the one gate.
 */
export function normalizeCatchUp(value: CatchUpInput): CatchUp {
  if (value === "all") return "all";
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) return value;
    throw invalidCatchUp(value);
  }
  if (typeof value !== "string") throw invalidCatchUp(value);
  const match = DURATION_PATTERN.exec(value.trim());
  if (match === null) throw invalidCatchUp(value);
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_UNITS;
  const ms = amount * DURATION_UNITS[unit];
  if (!Number.isSafeInteger(ms)) throw invalidCatchUp(value);
  return ms;
}

function invalidKeep(value: unknown): ArgosError {
  return new ArgosError(
    "invalid_request",
    `keep ${JSON.stringify(value)} is invalid: use "all" or a whole number from 1 to 1000`,
  );
}

/**
 * FR9.1: `"all"`, or a whole number from 1 to 1,000. The upper bound keeps one schedule's pruning
 * work bounded by the same number as the `runIds` cap.
 */
export function normalizeKeep(value: KeepInput): Keep {
  if (value === "all") return "all";
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000) {
    return value;
  }
  throw invalidKeep(value);
}
