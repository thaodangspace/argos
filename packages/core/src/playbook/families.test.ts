/**
 * FR8: roles are root-local. A home playbook resolves `<home>/roles` first and a repository
 * playbook the repository roots first, each sub-playbook keeps the family of its own file, one IR
 * may not resolve a role id to two different contents, and validate warns only when two copies
 * actually differ.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook, type LoadWarning } from "./load.js";

const FAMILIES = join(fileURLToPath(new URL("../../test/fixtures", import.meta.url)), "families");
const REPO = join(FAMILIES, "repo");
const HOME = join(FAMILIES, "home");

const REPO_REVIEWER = join(REPO, ".argos/roles/reviewer/role.yaml");
const HOME_REVIEWER = join(HOME, "roles/reviewer/role.yaml");

function codes(warnings: readonly LoadWarning[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe("root-local role precedence (FR8.1)", () => {
  it("gives a home playbook the home role copy", () => {
    const ir = loadPlaybook(REPO, "shared", { home: HOME });
    const review = ir.steps.find((step) => step.id === "review");

    expect(review?.role?.id).toBe("reviewer");
    expect(review?.role?.title).toBe("Home Reviewer");
    expect(review?.role?.readonly).toBe(true);
    expect(review?.role?.instructions).toContain("Global reviewer instructions.");
    // A role that only the home family defines resolves normally, without a warning.
    expect(ir.steps.find((step) => step.id === "polish")?.role?.title).toBe("Home Only");
  });

  it("gives a repository playbook the repository role copy", () => {
    const ir = loadPlaybook(REPO, "local", { home: HOME });
    const review = ir.steps.find((step) => step.id === "review");

    expect(review?.role?.id).toBe("reviewer");
    expect(review?.role?.title).toBe("Repo Reviewer");
    expect(review?.role?.readonly).toBe(false);
    expect(review?.role?.instructions).toContain("Repository reviewer instructions.");
  });

  it("keeps a repository playbook's IR and hash unchanged when a home library is added", () => {
    const repoOnly = loadPlaybook(REPO, "local");
    const withHome = loadPlaybook(REPO, "local", { home: HOME });
    expect(withHome.hash).toBe(repoOnly.hash);
  });

  it("gives a sub-playbook the roles of its own family (FR8.2)", () => {
    const ir = loadPlaybook(REPO, "mixed", { home: HOME });
    const check = ir.steps.find((step) => step.id === "block.check");

    expect(check?.use).toStrictEqual({ blockId: "block", playbookId: "child", depth: 1 });
    expect(check?.role?.title).toBe("Home Reviewer");
    expect(check?.role?.readonly).toBe(true);
    // The parent names no role, so the child's copy is the only one in this IR.
    expect(ir.roles["reviewer"]?.title).toBe("Home Reviewer");
  });
});

describe("one role id, one content per IR (FR8.3)", () => {
  it("fails playbook_invalid naming both role files when the contents differ", () => {
    let error: unknown;
    try {
      loadPlaybook(REPO, "conflict", { home: HOME });
    } catch (caught) {
      error = caught;
    }
    expect(isArgosError(error)).toBe(true);
    if (!isArgosError(error)) return;
    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("block");
    expect(error.file).toContain("conflict.yaml");
    expect(error.message).toContain('role "reviewer"');
    expect(error.message).toContain(REPO_REVIEWER);
    expect(error.message).toContain(HOME_REVIEWER);
  });

  it("merges identical content silently and keeps the hash independent of the sink", () => {
    const warnings: LoadWarning[] = [];
    const withSink = loadPlaybook(REPO, "same", { home: HOME, warnings });
    const without = loadPlaybook(REPO, "same", { home: HOME });

    expect(withSink.roles["same-reviewer"]?.title).toBe("Shared Reviewer");
    expect(withSink.steps.find((step) => step.id === "block.check")?.role?.title).toBe(
      "Shared Reviewer",
    );
    expect(withSink.steps.find((step) => step.id === "finish")?.role?.title).toBe("Shared Reviewer");
    expect(warnings).toStrictEqual([]);
    expect(withSink.hash).toBe(without.hash);
  });
});

describe("shadowing warnings (FR8.4)", () => {
  it("warns playbook_shadowed for a hidden home playbook, only with a sink", () => {
    const warnings: LoadWarning[] = [];
    const withSink = loadPlaybook(REPO, "duplicate", { home: HOME, warnings });

    expect(withSink.title).toBe("Repo Duplicate");
    expect(codes(warnings)).toStrictEqual(["playbook_shadowed"]);
    expect(warnings[0]?.stepId).toBeNull();
    expect(warnings[0]?.file).toBe(join(REPO, ".argos/playbooks/duplicate.yaml"));
    expect(warnings[0]?.message).toContain(join(HOME, "playbooks/duplicate.yaml"));

    const without = loadPlaybook(REPO, "duplicate", { home: HOME });
    expect(without.title).toBe("Repo Duplicate");
    expect(without.hash).toBe(withSink.hash);
  });

  it("warns role_shadowed only when the two role copies differ, only with a sink", () => {
    const warnings: LoadWarning[] = [];
    const withSink = loadPlaybook(REPO, "local", { home: HOME, warnings });

    expect(codes(warnings)).toStrictEqual(["role_shadowed"]);
    expect(warnings[0]?.stepId).toBeNull();
    expect(warnings[0]?.file).toBe(REPO_REVIEWER);
    expect(warnings[0]?.message).toContain(REPO_REVIEWER);
    expect(warnings[0]?.message).toContain(HOME_REVIEWER);

    expect(loadPlaybook(REPO, "local", { home: HOME }).hash).toBe(withSink.hash);
  });

  it("warns role_shadowed from the family that wins and ignores a single-family role", () => {
    const warnings: LoadWarning[] = [];
    loadPlaybook(REPO, "shared", { home: HOME, warnings });
    // The home copy wins here: a home playbook resolved `reviewer` against the repository copy.
    expect(codes(warnings)).toStrictEqual(["role_shadowed"]);
    expect(warnings[0]?.file).toBe(HOME_REVIEWER);
    // `home-only` is defined in one family only, so it is never shadowed.
    expect(warnings.some((warning) => warning.message.includes('"home-only"'))).toBe(false);
  });
});
