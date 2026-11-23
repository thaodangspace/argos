/**
 * Hidden workflows (the rail's "Hide"): a per-browser view preference, parsed defensively so a
 * corrupt entry can never break the list.
 */

import { describe, expect, it } from "vitest";

import {
  HIDDEN_WORKFLOWS_KEY,
  isHidden,
  readHidden,
  toggleHidden,
  writeHidden,
  type HiddenStorage,
} from "./state/hidden-workflows.js";

function storage(initial: Record<string, string> = {}): HiddenStorage & {
  readonly data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("hidden workflows", () => {
  it("round-trips a sorted, de-duplicated list", () => {
    const store = storage();
    writeHidden(store, ["b", "a", "b"]);
    expect(store.data[HIDDEN_WORKFLOWS_KEY]).toBe('["a","b"]');
    expect(readHidden(store)).toEqual(["a", "b"]);
  });

  it("treats anything unparseable as nothing hidden", () => {
    expect(readHidden(undefined)).toEqual([]);
    expect(readHidden(storage())).toEqual([]);
    expect(readHidden(storage({ [HIDDEN_WORKFLOWS_KEY]: "{" }))).toEqual([]);
    expect(readHidden(storage({ [HIDDEN_WORKFLOWS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(readHidden(storage({ [HIDDEN_WORKFLOWS_KEY]: '["", "a", 3, "a"]' }))).toEqual(["a"]);
    expect(readHidden(storage({ [HIDDEN_WORKFLOWS_KEY]: "" }))).toEqual([]);
  });

  it("survives a storage that throws", () => {
    const throwing: HiddenStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readHidden(throwing)).toEqual([]);
    expect(() => writeHidden(throwing, ["a"])).not.toThrow();
  });

  it("toggles one workflow at a time", () => {
    expect(toggleHidden([], "release")).toEqual(["release"]);
    expect(toggleHidden(["release"], "release")).toEqual([]);
    expect(toggleHidden(["b"], "a")).toEqual(["a", "b"]);
    expect(isHidden(["a"], "a")).toBe(true);
    expect(isHidden(["a"], "b")).toBe(false);
  });
});
