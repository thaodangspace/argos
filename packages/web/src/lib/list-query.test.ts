/**
 * The list state in the address bar (spec FR11): parse, serialize, and merge. Pure, so the round trip
 * is pinned without a DOM.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIST_STATE,
  listStateToSearch,
  mergeListState,
  parseListState,
} from "./list-query.js";

describe("list state in the URL", () => {
  it("defaults every facet when the query is empty", () => {
    expect(parseListState("")).toEqual(DEFAULT_LIST_STATE);
    expect(listStateToSearch(DEFAULT_LIST_STATE)).toBe("");
  });

  it("round-trips a fully scoped list", () => {
    const state = {
      status: "failed",
      sort: "activity",
      project: "vsee",
      workflow: "note-forms-v2",
      trigger: "schedule",
      executor: "hc",
    } as const;
    const search = listStateToSearch(state);
    expect(search).toBe(
      "?status=failed&sort=activity&project=vsee&workflow=note-forms-v2&trigger=schedule&executor=hc",
    );
    expect(parseListState(search)).toEqual(state);
  });

  it("ignores unknown values instead of failing the page", () => {
    expect(parseListState("?status=nonsense&sort=sideways&trigger=maybe")).toEqual(
      DEFAULT_LIST_STATE,
    );
    expect(parseListState("?project=&workflow=")).toEqual(DEFAULT_LIST_STATE);
  });

  it("clears a facet with an explicit undefined and keeps the rest", () => {
    const state = parseListState("?project=vsee&workflow=release&status=failed");
    const cleared = mergeListState(state, { workflow: undefined });
    expect(cleared).toEqual({ status: "failed", sort: "start", project: "vsee" });
    expect(mergeListState(cleared, { project: undefined })).toEqual({
      status: "failed",
      sort: "start",
    });
  });

  it("replaces a facet value", () => {
    expect(mergeListState(DEFAULT_LIST_STATE, { status: "running" })).toEqual({
      status: "running",
      sort: "start",
    });
    expect(mergeListState(DEFAULT_LIST_STATE, { sort: "activity", trigger: "fork" })).toEqual({
      status: "all",
      sort: "activity",
      trigger: "fork",
    });
  });
});
