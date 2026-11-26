/**
 * The tone → class map (spec FR21). Every map must cover exactly the `StatusTone` union, and every
 * value must be a real Skeleton colour-pairing utility: only `50-950, 100-900, 200-800, 300-700,
 * 400-600, 600-400, 700-300, 800-200, 900-100, 950-50` exist, so `-500-400` is not a colour.
 */

import { describe, expect, it } from "vitest";

import type { StatusTone } from "@thaodangspace/argos-core/view";

import {
  TONE_BG,
  TONE_BG_SOFT,
  TONE_BORDER,
  TONE_FILL,
  TONE_TEXT,
  TONE_VALUES,
  toneClass,
} from "./tone.js";

/** `@thaodangspace/argos-core/view` exports the union but no runtime list, so it is spelled here. */
const TONES = ["neutral", "accent", "success", "warning", "danger"] as const satisfies
  readonly StatusTone[];

const CLASS_SHAPE = /^(text|bg|border|fill)-(surface|primary|success|warning|error)-[a-z0-9/-]+$/;

describe("tone maps", () => {
  const maps = {
    TONE_TEXT,
    TONE_BG,
    TONE_BG_SOFT,
    TONE_BORDER,
    TONE_FILL,
  } satisfies Record<string, Readonly<Record<StatusTone, string>>>;

  for (const [name, map] of Object.entries(maps)) {
    it(`${name} covers exactly the StatusTone union`, () => {
      expect(Object.keys(map).sort()).toEqual([...TONES].sort());
    });

    it(`${name} holds only Skeleton colour-class names`, () => {
      for (const value of Object.values(map)) {
        expect(value).toMatch(CLASS_SHAPE);
        // `-500-400` is not a pairing Skeleton defines; it would compile to nothing.
        expect(value).not.toContain("-500-400");
      }
    });
  }

  it("exports the same tone ids in the same order", () => {
    expect([...TONE_VALUES]).toEqual([...TONES]);
  });

  it("falls back to neutral for an unknown or missing tone", () => {
    expect(toneClass(TONE_TEXT, "mystery" as never)).toBe(TONE_TEXT.neutral);
    expect(toneClass(TONE_TEXT, undefined)).toBe(TONE_TEXT.neutral);
    expect(toneClass(TONE_TEXT, "danger")).toBe(TONE_TEXT.danger);
  });
});
