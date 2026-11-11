import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook } from "./load.js";

const SUB = join(fileURLToPath(new URL("../../test/fixtures", import.meta.url)), "subplaybook");

function capture(id: string): unknown {
  try {
    loadPlaybook(SUB, id);
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
});
