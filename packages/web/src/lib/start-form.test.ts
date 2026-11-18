/**
 * The typed start form (spec FR13): default values, coercion, required fields, enum membership.
 */

import { describe, expect, it } from "vitest";

import type { PlaybookSummary } from "@thaodangspace/argos-core/rpc/contracts";

import { buildStartRequest, initialValues, newClientRequestId } from "./start-form.js";

const playbook: PlaybookSummary = {
  id: "release",
  file: "/repo/.argos/playbooks/release.yaml",
  hash: "h",
  stepCount: 2,
  inputs: [
    { name: "version", type: "string", required: true },
    { name: "dry_run", type: "boolean", required: false, default: false },
    { name: "count", type: "number", required: false },
    { name: "channel", type: "enum", required: false, values: ["stable", "beta"], default: "stable" },
    { name: "API_KEY", type: "string", required: false },
  ],
};

describe("initialValues", () => {
  it("prefills declared defaults and leaves strings empty", () => {
    expect(initialValues(playbook.inputs)).toEqual({
      version: "",
      dry_run: false,
      count: "",
      channel: "stable",
      API_KEY: "",
    });
  });
});

describe("buildStartRequest", () => {
  it("coerces each type and omits empty optional values", () => {
    const result = buildStartRequest({
      playbook,
      cwd: " /repo ",
      values: { version: "1.2.3", dry_run: true, count: "42", channel: "", API_KEY: "" },
    });
    expect(result).toEqual({
      ok: true,
      request: {
        playbookId: "release",
        cwd: "/repo",
        inputs: { version: "1.2.3", dry_run: true, count: 42 },
      },
    });
  });

  it("reports a missing required field and a bad number", () => {
    const result = buildStartRequest({
      playbook,
      cwd: "/repo",
      values: { version: " ", count: "abc" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["version"]).toContain("required");
      expect(result.errors["count"]).toContain("number");
    }
  });

  it("refuses an enum value outside the declared set", () => {
    const result = buildStartRequest({
      playbook,
      cwd: "/repo",
      values: { version: "1", channel: "nightly" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["channel"]).toContain("stable, beta");
  });

  it("requires a cwd and passes isolation/executor through", () => {
    const missing = buildStartRequest({ playbook, cwd: "  ", values: { version: "1" } });
    expect(missing.ok).toBe(false);

    const result = buildStartRequest({
      playbook,
      cwd: "/repo",
      values: { version: "1" },
      isolation: "worktree",
      executor: "hc",
    });
    expect(result).toEqual({
      ok: true,
      request: {
        playbookId: "release",
        cwd: "/repo",
        inputs: { version: "1" },
        isolation: { mode: "worktree" },
        executor: "hc",
      },
    });
  });
});

describe("newClientRequestId", () => {
  it("is unique per dialog open", () => {
    const ids = new Set([newClientRequestId(), newClientRequestId(), newClientRequestId()]);
    expect(ids.size).toBe(3);
    expect([...ids][0]?.startsWith("ui-")).toBe(true);
  });
});
