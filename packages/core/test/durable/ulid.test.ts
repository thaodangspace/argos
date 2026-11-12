import { describe, expect, it } from "vitest";

import { scheduleRunId } from "../../src/durable/schedule-docs.js";
import { resetUlidState, ulid, ulidFrom } from "../../src/durable/ulid.js";

/** Sixteen bytes of fixed "seed" material; `ulidFrom` only reads the first ten. */
const SEED = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

describe("ulid (D14)", () => {
  it("is 26 Crockford characters and monotonic within a millisecond", () => {
    resetUlidState();
    const values = [ulid(1_000), ulid(1_000), ulid(1_000), ulid(1_001)];
    for (const value of values) {
      expect(value).toHaveLength(26);
      expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual(values);
  });

  it("does not go backwards when the clock does", () => {
    resetUlidState();
    const later = ulid(2_000);
    const earlier = ulid(1_000);
    expect(earlier >= later).toBe(true);
  });
});

describe("ulidFrom (FR4.3)", () => {
  it("is deterministic and uses the same time encoding as ulid()", () => {
    resetUlidState();
    const first = ulidFrom(1_760_000_000_000, SEED);
    const second = ulidFrom(1_760_000_000_000, SEED);
    expect(second).toBe(first);
    expect(first).toHaveLength(26);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.slice(0, 10)).toBe(ulid(1_760_000_000_000).slice(0, 10));
    // Ten bytes of seed material; the rest is ignored.
    expect(ulidFrom(1_760_000_000_000, SEED.slice(0, 10))).toBe(first);
    // A different time or a different seed gives a different id.
    expect(ulidFrom(1_760_000_001_000, SEED)).not.toBe(first);
    expect(ulidFrom(1_760_000_000_000, Uint8Array.from([...SEED].reverse()))).not.toBe(first);
  });

  it("leaves the monotonic generator untouched", () => {
    resetUlidState();
    const before = ulid(1_000);
    // A future fire time must not move `lastTime`; otherwise the next `ulid()` would be clamped to
    // that fire time (or worse, jump the id sequence into the future).
    ulidFrom(9_999_999_999_999, SEED);
    const after = ulid(1_000);
    expect(after > before).toBe(true);
    expect(after.slice(0, 10)).toBe(before.slice(0, 10));
  });
});

describe("scheduleRunId (FR4.3)", () => {
  it("is the fire time plus a hash of the schedule uid", () => {
    const fireAt = 1_760_000_000_000;
    resetUlidState();
    const timePrefix = ulid(fireAt).slice(0, 10);
    const first = scheduleRunId("nightly", fireAt);
    expect(first).toBe(scheduleRunId("nightly", fireAt));
    expect(first.slice(0, 10)).toBe(timePrefix);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Two schedules due at the same instant must never share a run id.
    expect(scheduleRunId("hourly", fireAt)).not.toBe(first);
    // One schedule at two fire times must not either.
    expect(scheduleRunId("nightly", fireAt + 3_600_000)).not.toBe(first);
  });
});
