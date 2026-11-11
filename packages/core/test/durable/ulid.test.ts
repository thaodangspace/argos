import { describe, expect, it } from "vitest";

import { resetUlidState, ulid } from "../../src/durable/ulid.js";

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
