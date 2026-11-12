/**
 * FR1 strict keys: a typo in an `.argos/` or home playbook fails with `playbook_invalid` and
 * every issue reported (up to 20), while an upstream `.paseo/plugins/playbooks/` file whose only
 * problems are unknown keys keeps loading with `unknown_key` warnings.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError, type ArgosError } from "../errors.js";
import { loadPlaybook, type LoadWarning } from "./load.js";
import { RawOutputDefSchema } from "./schema.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const STRICT = join(FIXTURES, "strict");
const ARGOS_PLAYBOOKS = join(STRICT, ".argos", "playbooks");
const PASEO_PLAYBOOKS = join(STRICT, ".paseo", "plugins", "playbooks");

/** Load and return the failure, so each test can assert on code, step, and issues. */
function failure(id: string, home?: string): ArgosError {
  try {
    loadPlaybook(STRICT, id, home === undefined ? {} : { home });
  } catch (error) {
    if (isArgosError(error)) return error;
    throw error;
  }
  throw new Error(`fixture ${id} was expected to fail`);
}

/** A scratch `$ARGOS_HOME`; removed after the test. */
function tempHome(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "argos-strict-home-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("strict keys in .argos playbooks (FR1.1)", () => {
  it("rejects `need:` as playbook_invalid and names the step", () => {
    const error = failure("need-typo");
    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("body");
    expect(error.issues).toStrictEqual([
      { path: "steps.0.need", stepId: "body", message: 'unrecognized key "need"' },
    ]);
  });

  it("names the step of an issue under after[n].steps[m] (FR1.5)", () => {
    const error = failure("after-typo");
    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("tidy");
    expect(error.issues?.[0]?.stepId).toBe("tidy");
    expect(error.issues?.[0]?.path).toBe("after.0.steps.0.retires");
  });

  it("rejects an unknown key in an inputs.x definition", () => {
    const error = failure("input-typo");
    expect(error.code).toBe("playbook_invalid");
    expect(error.issues).toStrictEqual([
      { path: "inputs.request.typ", message: 'unrecognized key "typ"' },
    ]);
  });

  it("keeps `RawOutputDefSchema` strict through `.extend` (FR1.1)", () => {
    // `RawOutputDefSchema` is `RawVarDefSchema.extend({ value })`; the policy must survive.
    expect(RawOutputDefSchema.safeParse({ type: "string", valu: "x" }).success).toBe(false);
    expect(RawOutputDefSchema.safeParse({ type: "string", value: "x" }).success).toBe(true);
  });

  it("reports at most 20 issues (FR1.4)", () => {
    const error = failure("too-many");
    expect(error.code).toBe("playbook_invalid");
    expect(error.issues?.length).toBe(20);
    expect(error.issues?.every((issue) => issue.stepId === "work")).toBe(true);
    // The error names the first issue; the rest travel in `details.issues`.
    expect(error.message).toContain("typo01");
  });
});

describe("upstream-only keys are accepted and ignored (FR1.2, FR1.6)", () => {
  it("loads handoff/queue/settle, hidden/manager/workspace/next/singleton, and keeps the IR identical", () => {
    const upstream = loadPlaybook(STRICT, "upstream", {
      file: join(ARGOS_PLAYBOOKS, "upstream-keys.yaml"),
    });
    const plain = loadPlaybook(STRICT, "upstream", {
      file: join(ARGOS_PLAYBOOKS, "upstream-keys-plain.yaml"),
    });

    expect(upstream.steps.map((step) => step.id)).toStrictEqual(["work"]);
    expect(upstream.hash).toBe(plain.hash);
    expect(JSON.parse(JSON.stringify(upstream))).toStrictEqual(JSON.parse(JSON.stringify(plain)));
    expect(JSON.stringify(upstream)).not.toContain("continue_on_error");
    expect(JSON.stringify(upstream)).not.toContain("singleton");
  });
});

describe("upstream .paseo playbooks warn instead of failing (FR1.3)", () => {
  it("loads a file whose only issues are unknown keys and warns once per key", () => {
    const warnings: LoadWarning[] = [];
    const ir = loadPlaybook(STRICT, "legacy-unknown", { warnings });

    expect(ir.steps.map((step) => step.id)).toStrictEqual(["work"]);
    expect(warnings).toStrictEqual([
      {
        file: join(PASEO_PLAYBOOKS, "legacy-unknown.yaml"),
        stepId: "work",
        code: "unknown_key",
        message: 'unrecognized key "continue_on_error"',
      },
    ]);
  });

  it("still fails an upstream file with an unknown key plus a real error, reporting both", () => {
    const warnings: LoadWarning[] = [];
    const error = (() => {
      try {
        loadPlaybook(STRICT, "legacy-mixed", { warnings });
      } catch (caught) {
        if (isArgosError(caught)) return caught;
        throw caught;
      }
      throw new Error("fixture legacy-mixed was expected to fail");
    })();

    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("work");
    expect(warnings).toStrictEqual([]);
    const messages = (error.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`);
    expect(messages).toContain('steps.0.continue_on_error: unrecognized key "continue_on_error"');
    expect(messages.some((message) => message.startsWith("steps.0.retries:"))).toBe(true);
  });

  it("fails a home file with an unknown key", () => {
    const home = tempHome();
    try {
      const file = join(home.root, "playbooks", "global.yaml");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "title: Global\nsteps:\n  - id: work\n    prompt: Work\n    need: [prep]\n");
      const error = failure("global", home.root);
      expect(error.code).toBe("playbook_invalid");
      expect(error.stepId).toBe("work");
    } finally {
      home.cleanup();
    }
  });
});
