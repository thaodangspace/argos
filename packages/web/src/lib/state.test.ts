/**
 * The pure state helpers (spec FR11): list reducers, detail refetch rule, theme resolution, recents.
 */

import { describe, expect, it } from "vitest";

import type { RunDetail, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";

import { mergeRun, replaceRuns, shouldRefetchDetail } from "./state/reducers.js";
import { addRecent, RECENTS_LIMIT } from "./state/recents.js";
import { preferredTheme } from "./state/theme.svelte.js";

function run(id: string, updatedAt: number): RunSummary {
  return {
    id,
    playbookId: "release",
    playbookHash: "h",
    status: "running",
    inputs: {},
    cwd: "/repo",
    steps: [],
    gates: [],
    after: [],
    createdAt: updatedAt - 1,
    updatedAt,
    seq: 1,
  };
}

describe("run list reducers", () => {
  it("sorts a snapshot newest-first", () => {
    expect(replaceRuns([run("a", 1), run("b", 3), run("c", 2)]).map((entry) => entry.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("upserts without duplicating an id", () => {
    const first = mergeRun([], run("a", 1));
    const second = mergeRun(first, run("a", 5));
    expect(second).toHaveLength(1);
    expect(second[0]?.updatedAt).toBe(5);
    expect(mergeRun(second, run("b", 9)).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("refetches a detail only when seq moved", () => {
    const detail = { id: "a", seq: 4 } as RunDetail;
    expect(shouldRefetchDetail(null, 1)).toBe(true);
    expect(shouldRefetchDetail(detail, 4)).toBe(false);
    expect(shouldRefetchDetail(detail, 5)).toBe(true);
  });
});

describe("theme resolution", () => {
  it("prefers an explicit choice, then the OS", () => {
    expect(preferredTheme("light", true)).toBe("light");
    expect(preferredTheme("dark", false)).toBe("dark");
    expect(preferredTheme(null, true)).toBe("dark");
    expect(preferredTheme(null, false)).toBe("light");
    expect(preferredTheme("nonsense", false)).toBe("light");
  });
});

describe("cwd recents", () => {
  it("puts the newest first, de-duplicates, trims, and is bounded", () => {
    expect(addRecent([], " /a ")).toEqual(["/a"]);
    expect(addRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
    expect(addRecent(["/a"], "   ")).toEqual(["/a"]);
    const many = Array.from({ length: RECENTS_LIMIT + 4 }, (_, index) => `/r${String(index)}`);
    expect(addRecent(many, "/new")).toHaveLength(RECENTS_LIMIT);
  });
});
