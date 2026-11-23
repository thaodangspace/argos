/**
 * The pure state helpers (spec FR11): list reducers, detail refetch rule, theme resolution, recents.
 */

import { describe, expect, it } from "vitest";

import type { RunDetail, RunSummary } from "@thaodangspace/argos-core/rpc/contracts";

import { mergeRun, replaceRuns, shouldRefetchDetail } from "./state/reducers.js";
import { addRecent, RECENTS_LIMIT } from "./state/recents.js";
import { preferredTheme } from "./state/theme.svelte.js";
import {
  resolveTimeZone,
  TIMEZONE_STORAGE_KEY,
  timeZoneChoices,
  TimeZoneStore,
} from "./state/timezone.svelte.js";

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

describe("timezone preference", () => {
  it("follows the browser until this browser chooses a zone", () => {
    // Unset, empty, and unreadable all mean "the reader's own zone", never UTC.
    expect(resolveTimeZone(null)).toBeUndefined();
    expect(resolveTimeZone("")).toBeUndefined();
    expect(resolveTimeZone("   ")).toBeUndefined();
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone(" Asia/Saigon ")).toBe("Asia/Saigon");
  });

  it("offers UTC and every other known zone, the local one once", () => {
    const choices = timeZoneChoices("Asia/Saigon");
    expect(choices).toContain("UTC");
    expect(choices).toContain("America/New_York");
    // The browser's own zone is the picker's "Local" entry, so it is not listed twice.
    expect(choices).not.toContain("Asia/Saigon");
  });

  it("persists the choice through the storage seam", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => memory.get(key) ?? null,
      setItem: (key: string, value: string): void => void memory.set(key, value),
    };
    const store = new TimeZoneStore();
    store.init(storage);
    expect(TIMEZONE_STORAGE_KEY).toBe("argos.ui.timezone");
    // No stored choice: the browser's own zone, and the picker's "Local" entry names it.
    expect(store.timeZone).toBeUndefined();
    expect(store.system).not.toBe("");
    expect(store.choices.length).toBeGreaterThan(1);

    store.select("Europe/Berlin", storage);
    expect(store.timeZone).toBe("Europe/Berlin");
    expect(memory.get(TIMEZONE_STORAGE_KEY)).toBe("Europe/Berlin");

    // Back to "Local": the empty value keeps the key present but means "follow the browser".
    store.select("", storage);
    expect(store.timeZone).toBeUndefined();
    expect(memory.get(TIMEZONE_STORAGE_KEY)).toBe("");
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
