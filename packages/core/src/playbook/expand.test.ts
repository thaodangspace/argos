import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const SUB = join(FIXTURES, "subplaybook");
const FAMILIES = join(FIXTURES, "families");

function capture(id: string): unknown {
  try {
    loadPlaybook(SUB, id);
  } catch (error) {
    return error;
  }
  throw new Error(`fixture ${id} was expected to fail`);
}

/** Load a fixture that spans both root families, returning the error instead of throwing. */
function captureAcrossFamilies(id: string): unknown {
  try {
    loadPlaybook(join(FAMILIES, "repo"), id, { home: join(FAMILIES, "home") });
  } catch (error) {
    return error;
  }
  throw new Error(`fixture ${id} was expected to fail`);
}

describe("expandPlaybook: sub-playbooks (FR10)", () => {
  it("inlines the sub-playbook with the <stepId>. prefix and keeps the block addressable", () => {
    const ir = loadPlaybook(SUB, "parent");

    expect(ir.steps.map((step) => step.id)).toStrictEqual([
      "pr.investigate",
      "pr.implement",
      "finish",
    ]);
    expect(ir.steps[0]?.use).toStrictEqual({ blockId: "pr", playbookId: "child", depth: 1 });
    expect(ir.blocks["pr"]).toMatchObject({
      id: "pr",
      playbookId: "child",
      stepIds: ["pr.investigate", "pr.implement"],
      entry: ["pr.investigate"],
      terminals: ["pr.implement"],
    });
    // The parent's `needs: [pr]` now waits for the block's terminal step.
    expect(ir.steps.find((step) => step.id === "finish")?.needs).toStrictEqual(["pr.implement"]);
    // The sub-playbook input is fed by the block step's wiring.
    expect(ir.steps.find((step) => step.id === "pr.investigate")?.inputs).toStrictEqual({
      request: { from: "playbook", name: "request" },
    });
    expect(ir.steps.find((step) => step.id === "pr.implement")?.inputs).toStrictEqual({
      plan: { from: "step", stepId: "pr.investigate", output: "plan" },
    });
  });

  it("keeps the expanded IR JSON-stable and hash-stable", () => {
    const first = loadPlaybook(SUB, "parent");
    const second = loadPlaybook(SUB, "parent");
    expect(first.hash).toBe(second.hash);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
  });

  it("rejects a nested sub-playbook at depth 1", () => {
    const error = capture("deep");
    expect(isArgosError(error)).toBe(true);
    if (!isArgosError(error)) return;
    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("inner");
    expect(error.message).toContain("recursion depth 1 exceeded");
    expect(error.file).toContain("deep-child.yaml");
  });

  it("rejects a sub-playbook cycle with playbook_cycle", () => {
    const error = capture("cycle-a");
    expect(isArgosError(error)).toBe(true);
    if (!isArgosError(error)) return;
    expect(error.code).toBe("playbook_cycle");
    expect(error.stepId).toBe("hop");
    expect(error.message).toContain("cycle-a -> cycle-b -> cycle-a");
  });

  it("rejects a role id that the caller and the sub-playbook resolve differently (FR8.3)", () => {
    const error = captureAcrossFamilies("conflict");
    expect(isArgosError(error)).toBe(true);
    if (!isArgosError(error)) return;
    expect(error.code).toBe("playbook_invalid");
    expect(error.stepId).toBe("block");
    expect(error.file).toContain("conflict.yaml");
    expect(error.message).toContain('role "reviewer"');
    expect(error.message).toContain("different content");
    // Both role files are named, so the author can see which two copies collide.
    expect(error.message).toContain(join(FAMILIES, "repo/.argos/roles/reviewer/role.yaml"));
    expect(error.message).toContain(join(FAMILIES, "home/roles/reviewer/role.yaml"));
  });
});
