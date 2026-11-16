/**
 * Usage aggregation (FR26): the read model's step/run totals are arithmetic over the attempts the
 * executor reported. Counters add, gauges peak, and an empty report stays absent.
 */

import { describe, expect, it } from "vitest";

import type { AttemptRecord } from "./record.js";
import { accumulateUsage, aggregateUsage, attemptUsage, USAGE_GAUGE_KEYS } from "./usage.js";

function attempt(n: number, usage?: Readonly<Record<string, number>>): AttemptRecord {
  return { n, startedAt: n * 1_000, ...(usage === undefined ? {} : { usage }) };
}

describe("aggregateUsage", () => {
  it("sums counters and keeps the keys sorted", () => {
    expect(
      aggregateUsage([
        { outputTokens: 10, inputTokens: 3, totalCostUsd: 0.25 },
        { inputTokens: 7, outputTokens: 5, totalCostUsd: 0.5 },
      ]),
    ).toEqual({ inputTokens: 10, outputTokens: 15, totalCostUsd: 0.75 });
  });

  it("keeps a gauge's peak instead of summing it", () => {
    expect(USAGE_GAUGE_KEYS).toContain("contextWindowUsedTokens");
    expect(
      aggregateUsage([
        { contextWindowUsedTokens: 4_096, contextWindowMaxTokens: 200_000, inputTokens: 10 },
        { contextWindowUsedTokens: 8_192, contextWindowMaxTokens: 100_000, inputTokens: 5 },
      ]),
    ).toEqual({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 8_192,
      inputTokens: 15,
    });
  });

  it("skips non-finite readings and keeps the key absent when nothing is left", () => {
    expect(aggregateUsage([undefined, {}, { inputTokens: Number.NaN }])).toBeUndefined();
    expect(aggregateUsage([])).toBeUndefined();
    expect(aggregateUsage([{ inputTokens: 4, outputTokens: Number.POSITIVE_INFINITY }])).toEqual({
      inputTokens: 4,
    });
  });

  it("treats an unknown provider counter as additive", () => {
    expect(aggregateUsage([{ reasoningTokens: 2 }, { reasoningTokens: 3 }])).toEqual({
      reasoningTokens: 5,
    });
  });
});

describe("attemptUsage", () => {
  it("aggregates one step's attempts", () => {
    expect(
      attemptUsage([
        attempt(1, { inputTokens: 100, totalCostUsd: 0.1 }),
        attempt(2, { inputTokens: 50, outputTokens: 20, totalCostUsd: 0.2 }),
      ]),
    ).toEqual({ inputTokens: 150, outputTokens: 20, totalCostUsd: 0.30000000000000004 });
    expect(attemptUsage([attempt(1)])).toBeUndefined();
  });
});

describe("accumulateUsage", () => {
  it("adds into a caller-owned total", () => {
    const total: Record<string, number> = { inputTokens: 1, contextWindowUsedTokens: 10 };
    accumulateUsage(total, { inputTokens: 2, contextWindowUsedTokens: 5 });
    expect(total).toEqual({ inputTokens: 3, contextWindowUsedTokens: 10 });
  });
});
