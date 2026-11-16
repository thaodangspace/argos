/**
 * Usage aggregation for the read model (FR26).
 *
 * The Paseo adapter reports provider/token accounting as free-form numbers (`totalCostUsd`,
 * `inputTokens`, `outputTokens`, `cachedInputTokens`, …) and Argos stores them verbatim on each
 * attempt. This module is the only place that does arithmetic on them, so a run's cost and every
 * step's cost are one deterministic projection of the checkpoint — not a second source of truth.
 *
 * Counters are summed; gauges ({@link USAGE_GAUGE_KEYS}) keep the peak, because adding two
 * snapshots of "tokens currently in the context window" would report a nonsense total. An unknown
 * key a provider adds later is treated as a counter, which is the useful default.
 */

import type { AttemptRecord } from "./record.js";

/** One usage record: provider/token counters keyed by the executor's own names. */
export type UsageTotals = Readonly<Record<string, number>>;

/**
 * Usage keys that are instantaneous readings, not counters: aggregating two attempts keeps the
 * larger value instead of adding them.
 */
export const USAGE_GAUGE_KEYS: readonly string[] = [
  "contextWindowUsedTokens",
  "contextWindowMaxTokens",
];

const GAUGE_KEYS: ReadonlySet<string> = new Set(USAGE_GAUGE_KEYS);

/**
 * Add one usage reading into `total` in place: counters sum, gauges keep the peak. A non-finite
 * number is skipped, so a provider that reports `NaN` cannot poison a whole run's total.
 */
export function accumulateUsage(
  total: Record<string, number>,
  usage: Readonly<Record<string, number>> | undefined,
): void {
  if (usage === undefined) return;
  for (const [key, value] of Object.entries(usage)) {
    if (!Number.isFinite(value)) continue;
    const current = total[key];
    if (GAUGE_KEYS.has(key)) {
      total[key] = current === undefined ? value : Math.max(current, value);
    } else {
      total[key] = current === undefined ? value : current + value;
    }
  }
}

/**
 * Aggregate usage readings (one per attempt, or one per step) into a single record.
 *
 * `undefined` when no source reported a finite number, so a run with no accounting keeps the key
 * absent instead of publishing an empty `{}`. Keys are sorted, so the JSON is byte-stable no
 * matter which attempt reported a counter first.
 */
export function aggregateUsage(
  sources: readonly (Readonly<Record<string, number>> | undefined)[],
): UsageTotals | undefined {
  const total: Record<string, number> = {};
  for (const usage of sources) accumulateUsage(total, usage);
  const keys = Object.keys(total);
  if (keys.length === 0) return undefined;
  const sorted: Record<string, number> = {};
  for (const key of keys.sort()) sorted[key] = total[key] as number;
  return sorted;
}

/** Aggregate one step's attempts (`undefined` when no attempt reported usage). */
export function attemptUsage(attempts: readonly AttemptRecord[]): UsageTotals | undefined {
  return aggregateUsage(attempts.map((attempt) => attempt.usage));
}
