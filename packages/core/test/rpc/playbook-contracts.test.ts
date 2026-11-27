/**
 * The playbook editor's wire contract (spec FR6–FR15): the schemas read, validate, and save share,
 * the additive `issues[]` detail, the 512 KiB text limit, the mandatory `baseSha256`, and the
 * `playbook_conflict` code/status pair. No server and no file: shape only.
 */

import { describe, expect, it } from "vitest";

import { ARGOS_ERROR_CODES, ArgosError, argosError } from "../../src/errors.js";
import {
  PLAYBOOK_CONFLICT_REASONS,
  PLAYBOOK_ISSUE_LIMIT,
  PLAYBOOK_TEXT_LIMIT,
  PlaybookFileResponseSchema,
  PlaybookIssueSchema,
  PlaybookLoadErrorSchema,
  PlaybookSaveRequestSchema,
  PlaybookSaveResponseSchema,
  PlaybookValidateRequestSchema,
  PlaybookVerdictSchema,
  RPC_ERROR_STATUS,
  statusForCode,
  type PlaybookSaveRequest,
  type PlaybookValidateRequest,
} from "../../src/rpc/contracts.js";

/** A minimal graph: the projection only has to parse, not to be interesting here. */
const GRAPH = { nodes: [], edges: [], entry: [], terminals: [] };

const SHA256 = "a".repeat(64);

const VALIDATE_REQUEST: PlaybookValidateRequest = {
  cwd: "/repo",
  file: "/repo/.argos/playbooks/demo.yaml",
  yaml: "title: Demo\n",
  graph: true,
};

const SAVE_REQUEST: PlaybookSaveRequest = { ...VALIDATE_REQUEST, baseSha256: SHA256 };

const VERDICT = {
  playbookId: "demo",
  valid: true,
  errors: [],
  warnings: [],
  hash: "f".repeat(64),
  graph: GRAPH,
};

describe("playbook editor constants", () => {
  it("pins the text and issue limits and the conflict reasons", () => {
    expect(PLAYBOOK_TEXT_LIMIT).toBe(512 * 1024);
    expect(PLAYBOOK_ISSUE_LIMIT).toBe(20);
    expect(PLAYBOOK_CONFLICT_REASONS).toEqual(["changed", "deleted"]);
  });
});

describe("playbook_conflict", () => {
  it("is a stable Argos code mapped to 409", () => {
    expect(ARGOS_ERROR_CODES).toContain("playbook_conflict");
    expect(RPC_ERROR_STATUS["playbook_conflict"]).toBe(409);
    expect(statusForCode("playbook_conflict")).toBe(409);
  });

  it("carries details.reason, and no other code needs one", () => {
    const changed = argosError(
      "playbook_conflict",
      { file: "/repo/.argos/playbooks/demo.yaml" },
      "the file changed on disk since it was loaded",
      undefined,
      { reason: "changed" },
    );
    expect(changed).toBeInstanceOf(ArgosError);
    expect(changed.code).toBe("playbook_conflict");
    expect(changed.reason).toBe("changed");

    const deleted = new ArgosError("playbook_conflict", "gone", { reason: "deleted" });
    expect(deleted.reason).toBe("deleted");

    expect(argosError("playbook_invalid", {}, "bad").reason).toBeUndefined();
  });
});

describe("PlaybookIssueSchema", () => {
  it("round-trips with and without a step id", () => {
    const withStep = { path: "steps.0.prompt", stepId: "build", message: "expected a string" };
    const withoutStep = { path: "steps", message: "expected an array" };
    expect(PlaybookIssueSchema.parse(withStep)).toEqual(withStep);
    expect(PlaybookIssueSchema.parse(withoutStep)).toEqual(withoutStep);
  });

  it("rejects an extra key", () => {
    expect(
      PlaybookIssueSchema.safeParse({ path: "a", message: "b", value: "secret" }).success,
    ).toBe(false);
  });
});

describe("PlaybookLoadErrorSchema", () => {
  it("parses without issues (the default listing) and with them (issues=1)", () => {
    const plain = { file: "/repo/broken.yaml", code: "playbook_invalid", message: "broken" };
    expect(PlaybookLoadErrorSchema.parse(plain)).toEqual(plain);
    expect(PlaybookLoadErrorSchema.parse(plain)).not.toHaveProperty("issues");

    const detailed = {
      ...plain,
      issues: [{ path: "steps.0", stepId: "a", message: "expected a string" }],
    };
    expect(PlaybookLoadErrorSchema.parse(detailed)).toEqual(detailed);
  });

  it("rejects an unknown key", () => {
    const result = PlaybookLoadErrorSchema.safeParse({
      file: "/repo/broken.yaml",
      code: "playbook_invalid",
      message: "broken",
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("PlaybookValidateRequestSchema", () => {
  it("round-trips, with and without the optional graph flag", () => {
    expect(PlaybookValidateRequestSchema.parse(VALIDATE_REQUEST)).toEqual(VALIDATE_REQUEST);
    const bare = { cwd: "/repo", file: "/repo/.argos/playbooks/demo.yaml", yaml: "title: Demo\n" };
    expect(PlaybookValidateRequestSchema.parse(bare)).toEqual(bare);
  });

  it("accepts exactly the limit and rejects one more", () => {
    const atLimit = { ...VALIDATE_REQUEST, yaml: "a".repeat(PLAYBOOK_TEXT_LIMIT) };
    expect(PlaybookValidateRequestSchema.safeParse(atLimit).success).toBe(true);
    const overLimit = { ...VALIDATE_REQUEST, yaml: "a".repeat(PLAYBOOK_TEXT_LIMIT + 1) };
    expect(PlaybookValidateRequestSchema.safeParse(overLimit).success).toBe(false);
  });

  it("rejects an extra key", () => {
    expect(
      PlaybookValidateRequestSchema.safeParse({ ...VALIDATE_REQUEST, baseSha256: SHA256 }).success,
    ).toBe(false);
  });
});

describe("PlaybookVerdictSchema / PlaybookFileResponseSchema", () => {
  it("round-trips a verdict, with and without hash/graph", () => {
    expect(PlaybookVerdictSchema.parse(VERDICT)).toEqual(VERDICT);
    const minimal = { playbookId: "demo", valid: false, errors: [], warnings: [] };
    expect(PlaybookVerdictSchema.parse(minimal)).toEqual(minimal);
  });

  it("round-trips a file response carrying cwd, realpath, text, and digest", () => {
    const response = {
      ...VERDICT,
      cwd: "/repo",
      file: "/repo/.argos/playbooks/demo.yaml",
      yaml: "title: Demo\n",
      sha256: SHA256,
    };
    expect(PlaybookFileResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects an extra key on both", () => {
    expect(PlaybookVerdictSchema.safeParse({ ...VERDICT, extra: 1 }).success).toBe(false);
    expect(
      PlaybookFileResponseSchema.safeParse({
        ...VERDICT,
        cwd: "/repo",
        file: "/repo/.argos/playbooks/demo.yaml",
        yaml: "",
        sha256: SHA256,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("PlaybookSaveRequestSchema", () => {
  it("round-trips a save request", () => {
    expect(PlaybookSaveRequestSchema.parse(SAVE_REQUEST)).toEqual(SAVE_REQUEST);
  });

  it("requires a baseSha256 matching /^[0-9a-f]{64}$/", () => {
    const { baseSha256: _absent, ...withoutDigest } = SAVE_REQUEST;
    expect(PlaybookSaveRequestSchema.safeParse(withoutDigest).success).toBe(false);
    for (const bad of [
      "A".repeat(64), // uppercase is not the digest Argos publishes
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      "a".repeat(64) + "\n",
    ]) {
      expect(PlaybookSaveRequestSchema.safeParse({ ...SAVE_REQUEST, baseSha256: bad }).success, bad)
        .toBe(false);
    }
    expect(
      PlaybookSaveRequestSchema.safeParse({ ...SAVE_REQUEST, baseSha256: SHA256 }).success,
    ).toBe(true);
  });

  it("rejects an extra key", () => {
    expect(
      PlaybookSaveRequestSchema.safeParse({ ...SAVE_REQUEST, force: true }).success,
    ).toBe(false);
  });
});

describe("PlaybookSaveResponseSchema", () => {
  it("round-trips the success body and demands written: true", () => {
    const response = {
      ...VERDICT,
      file: "/repo/.argos/playbooks/demo.yaml",
      sha256: SHA256,
      written: true,
      mode: 0o644,
    };
    expect(PlaybookSaveResponseSchema.parse(response)).toEqual(response);
    expect(PlaybookSaveResponseSchema.safeParse({ ...response, written: false }).success).toBe(false);
    expect(PlaybookSaveResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
  });
});
