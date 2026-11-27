/**
 * The editor's pure model (editor FR22–FR25): dirty, save eligibility, issue order, the issue cap, the
 * conflict text, and the caret line an issue points at. No DOM — the component test asserts markup.
 */

import { describe, expect, it } from "vitest";

import {
  PLAYBOOK_ISSUE_LIMIT,
  type PlaybookIssue,
  type PlaybookLoadError,
} from "@thaodangspace/argos-core/rpc/contracts";

import {
  boundedIssues,
  conflictText,
  isDirty,
  isWritablePlaybook,
  issueList,
  lineForIssue,
  offsetForLine,
  orderIssues,
  saveEligibility,
  verdictIssues,
} from "./playbook-editor.js";

const FAILED: PlaybookLoadError = {
  file: "/repo/.argos/playbooks/release.yaml",
  code: "playbook_invalid",
  message: "steps.0: unrecognized key \"promt\"",
};

describe("dirty detection", () => {
  it("compares the buffer with the loaded text byte for byte", () => {
    expect(isDirty("id: a\n", "id: a\n")).toBe(false);
    expect(isDirty("id: b\n", "id: a\n")).toBe(true);
    // A trailing newline is a change: the file is written as typed (editor FR16).
    expect(isDirty("id: a", "id: a\n")).toBe(true);
    expect(isDirty("", "")).toBe(false);
  });
});

describe("save eligibility", () => {
  it("is on only for a dirty, valid, writable buffer", () => {
    expect(saveEligibility({ dirty: true, valid: true, writable: true })).toMatchObject({
      canSave: true,
      reason: null,
    });
  });

  it("is off for a clean buffer", () => {
    expect(saveEligibility({ dirty: false, valid: true, writable: true })).toMatchObject({
      canSave: false,
      reason: "clean",
    });
  });

  it("is off for an invalid buffer", () => {
    expect(saveEligibility({ dirty: true, valid: false, writable: true })).toMatchObject({
      canSave: false,
      reason: "invalid",
    });
  });

  it("is off for a read-only path, even when everything else would allow it", () => {
    const readOnly = saveEligibility({ dirty: true, valid: true, writable: false });
    expect(readOnly).toMatchObject({ canSave: false, reason: "read-only" });
    expect(readOnly.hint).toContain("read-only");
  });
});

describe("writability", () => {
  it("accepts the two repository roots only", () => {
    expect(isWritablePlaybook("/repo", "/repo/.argos/playbooks/release.yaml")).toBe(true);
    expect(
      isWritablePlaybook("/repo", "/repo/.paseo/plugins/playbooks/release.yaml"),
    ).toBe(true);
  });

  it("refuses a home playbook, a sibling repository, and an unset scope", () => {
    expect(isWritablePlaybook("/repo", "/home/me/.argos/playbooks/release.yaml")).toBe(false);
    expect(isWritablePlaybook("/repo", "/other/.argos/playbooks/release.yaml")).toBe(false);
    expect(isWritablePlaybook("/repo", "/repo/.argos/roles/build/role.yaml")).toBe(false);
    expect(isWritablePlaybook("", "/repo/.argos/playbooks/release.yaml")).toBe(false);
  });

  it("tolerates a trailing separator and a Windows spelling", () => {
    expect(isWritablePlaybook("/repo/", "/repo/.argos/playbooks/a.yaml")).toBe(true);
    expect(isWritablePlaybook("C:\\repo", "C:\\repo\\.argos\\playbooks\\a.yaml")).toBe(true);
  });
});

describe("issue ordering", () => {
  const issues: PlaybookIssue[] = [
    { stepId: "review", path: "steps.1.prompt", message: "b" },
    { stepId: "build", path: "steps.0.on.complete", message: "d" },
    { path: "steps", message: "file-level" },
    { stepId: "build", path: "steps.0.agent", message: "c" },
  ];

  it("sorts by step, then by path inside the document", () => {
    expect(orderIssues(issues).map((issue) => [issue.stepId ?? "", issue.path])).toEqual([
      ["", "steps"],
      ["build", "steps.0.agent"],
      ["build", "steps.0.on.complete"],
      ["review", "steps.1.prompt"],
    ]);
  });

  it("does not mutate its input", () => {
    const copy = [...issues];
    orderIssues(issues);
    expect(issues).toEqual(copy);
  });
});

describe("the issue cap", () => {
  const many = (count: number): PlaybookIssue[] =>
    Array.from({ length: count }, (_, index) => ({
      stepId: "build",
      path: `steps.0.field_${String(index).padStart(2, "0")}`,
      message: `issue ${index}`,
    }));

  it("keeps the first PLAYBOOK_ISSUE_LIMIT rows and counts the rest", () => {
    const bounded = boundedIssues(many(PLAYBOOK_ISSUE_LIMIT + 5));
    expect(bounded.issues).toHaveLength(PLAYBOOK_ISSUE_LIMIT);
    expect(bounded.hidden).toBe(5);
    expect(bounded.issues[0]?.path).toBe("steps.0.field_00");
  });

  it("caps a verdict's flattened issue list, not only one error's", () => {
    const errors: PlaybookLoadError[] = [
      { ...FAILED, issues: many(PLAYBOOK_ISSUE_LIMIT) },
      { ...FAILED, file: "/repo/.argos/playbooks/other.yaml", issues: many(3) },
    ];
    const list = issueList(errors);
    expect(list.issues).toHaveLength(PLAYBOOK_ISSUE_LIMIT);
    expect(list.hidden).toBe(3);
    expect(issueList([{ ...FAILED, issues: many(2) }])).toMatchObject({ hidden: 0 });
  });
});

describe("the verdict's issues", () => {
  it("flattens every error's issues", () => {
    expect(
      verdictIssues([
        { ...FAILED, issues: [{ path: "steps.0.prompt", stepId: "build", message: "m" }] },
      ]),
    ).toEqual([{ path: "steps.0.prompt", stepId: "build", message: "m" }]);
  });

  it("keeps an error that carries no issues readable", () => {
    expect(verdictIssues([FAILED])).toEqual([
      { path: "(root)", message: "playbook_invalid: steps.0: unrecognized key \"promt\"" },
    ]);
  });
});

describe("conflict text", () => {
  it("names the changed and deleted cases", () => {
    expect(conflictText("changed")).toContain("changed on disk");
    expect(conflictText("deleted")).toContain("deleted");
  });

  it("still reads as a conflict for an unknown or absent reason", () => {
    for (const reason of ["renamed", undefined]) {
      const text = conflictText(reason);
      expect(text).toContain("no longer matches");
      expect(text).toContain("Reload");
    }
  });
});

describe("the caret line", () => {
  const yaml = "id: release\nsteps:\n  - id: build\n    prompt: hi\n";

  it("maps an issue path to the line of its deepest key", () => {
    expect(lineForIssue("steps.0.prompt", yaml)).toBe(4);
    // `id` occurs on the root line first; the loader's path is a document path, not an offset, so
    // the first matching key is the honest answer (the caret lands on the file's `id:`).
    expect(lineForIssue("steps.0.id", yaml)).toBe(1);
    expect(lineForIssue("(root)", yaml)).toBe(1);
  });

  it("falls back to the nearest key that exists, and gives up when none does", () => {
    // `missing_key` is not in the text, but its parent `steps:` is: the caret lands there.
    expect(lineForIssue("steps.0.missing_key", yaml)).toBe(2);
    expect(lineForIssue("nope.nothing", yaml)).toBeUndefined();
    expect(lineForIssue("(root)", "")).toBeUndefined();
  });

  it("turns a line into a character offset inside the text", () => {
    expect(offsetForLine(yaml, 1)).toBe(0);
    expect(offsetForLine(yaml, 4)).toBe(yaml.indexOf("    prompt"));
    expect(offsetForLine(yaml, 99)).toBe(yaml.length);
  });
});
