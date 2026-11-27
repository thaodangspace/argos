/**
 * The editor's URL state (editor FR20): `?cwd=&file=` round-trips, an empty and a partial query are
 * tolerated, and a key the editor does not own is dropped rather than echoed.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_PLAYBOOK_SELECTION,
  parsePlaybookQuery,
  playbookQueryToSearch,
} from "./playbook-query.js";

describe("playbook query", () => {
  it("round-trips an absolute cwd and file", () => {
    const selection = { cwd: "/a b", file: "/a b/.argos/playbooks/release.yaml" };
    const search = playbookQueryToSearch(selection);
    const params = new URLSearchParams(search);
    expect(params.get("cwd")).toBe("/a b");
    expect(params.get("file")).toBe("/a b/.argos/playbooks/release.yaml");
    expect(parsePlaybookQuery(search)).toEqual(selection);
  });

  it("treats an empty query as no selection", () => {
    expect(parsePlaybookQuery("")).toEqual(EMPTY_PLAYBOOK_SELECTION);
    expect(parsePlaybookQuery("?")).toEqual(EMPTY_PLAYBOOK_SELECTION);
    expect(playbookQueryToSearch(EMPTY_PLAYBOOK_SELECTION)).toBe("");
  });

  it("keeps a partial query instead of failing it", () => {
    expect(parsePlaybookQuery("?file=/repo/.argos/playbooks/a.yaml")).toEqual({
      cwd: null,
      file: "/repo/.argos/playbooks/a.yaml",
    });
    expect(parsePlaybookQuery("?cwd=/repo")).toEqual({ cwd: "/repo", file: null });
    // A blank value is the same as absent: the page falls back, it does not ask for "".
    expect(parsePlaybookQuery("?cwd=&file=")).toEqual(EMPTY_PLAYBOOK_SELECTION);
  });

  it("drops an unknown key", () => {
    const search = playbookQueryToSearch(
      parsePlaybookQuery("?cwd=/repo&view=graph&file=/repo/.argos/playbooks/a.yaml&step=1"),
    );
    expect(search).toBe(
      "?cwd=%2Frepo&file=%2Frepo%2F.argos%2Fplaybooks%2Fa.yaml",
    );
    expect(search).not.toContain("view");
    expect(search).not.toContain("step");
  });
});
