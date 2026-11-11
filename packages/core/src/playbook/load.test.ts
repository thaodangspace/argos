import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { discoverPlaybooks, discoverRoles, discoverScripts, loadPlaybook } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const COMPAT = join(FIXTURES, "compat");

describe("loadPlaybook: golden compat fixtures (D13)", () => {
  it.each([
    { id: "pr", steps: ["investigate", "implement", "review", "local_qa", "babysit"] },
    { id: "docs", steps: ["investigate", "write", "review", "consistency", "verdict", "approve"] },
  ])("loads $id twice with an identical hash and a JSON-stable IR", ({ id, steps }) => {
    const first = loadPlaybook(COMPAT, id);
    const second = loadPlaybook(COMPAT, id);

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).toBe(second.hash);
    expect([...first.steps.map((step) => step.id)]).toStrictEqual(steps);
    expect(JSON.parse(JSON.stringify(first))).toStrictEqual(first);
  });

  it("loads the compat fixtures from the .paseo/plugins/playbooks fallback", () => {
    const entries = discoverPlaybooks(COMPAT);
    expect(entries.map((entry) => entry.id)).toStrictEqual(["docs", "pr"]);
    for (const entry of entries) expect(entry.root).toBe(".paseo/plugins/playbooks");
  });

  it("resolves role instructions, agent defaults, and the mode alias", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const implement = ir.steps.find((step) => step.id === "implement");

    expect(implement?.role?.id).toBe("implementer");
    expect(implement?.role?.readonly).toBe(false);
    expect(implement?.role?.instructions).toContain("Implementer of a pull-request playbook");
    // defaults/main.yaml `agent: { tier: worker, mode: bypassPermissions }`
    expect(implement?.agent).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
    });
    expect(implement?.timeout).toBe("1h");
    expect(implement?.retries).toBe(1);
  });

  it("wires inputs from playbook inputs and earlier step outputs", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    const implement = ir.steps.find((step) => step.id === "implement");

    expect(implement?.inputs).toStrictEqual({
      request: { from: "playbook", name: "request" },
      plan: { from: "step", stepId: "investigate", output: "plan" },
      base_branch: { from: "playbook", name: "base_branch" },
    });
    const babysit = ir.steps.find((step) => step.id === "babysit");
    expect(babysit?.inputs).toStrictEqual({
      pr_url: { from: "step", stepId: "implement", output: "pr_url" },
      review: { from: "step", stepId: "review", output: "findings" },
      qa: { from: "step", stepId: "local_qa", output: "report" },
    });
  });

  it("keeps the gate choices and goto loop of the compat fixtures", () => {
    const docs = loadPlaybook(COMPAT, "docs");
    const approve = docs.steps.find((step) => step.id === "approve");
    const verdict = docs.steps.find((step) => step.id === "verdict");

    expect(approve?.kind).toBe("gate");
    expect(Object.keys(approve?.gate?.choices ?? {})).toStrictEqual(["approved", "rejected"]);
    expect(approve?.on["rejected"]).toStrictEqual({ kind: "goto", target: "write" });
    expect(verdict?.on["changes_requested"]).toStrictEqual({
      kind: "goto",
      target: "write",
      maxLoops: 2,
    });
  });

  it("freezes the IR deeply", () => {
    const ir = loadPlaybook(COMPAT, "pr");
    expect(Object.isFrozen(ir)).toBe(true);
    expect(Object.isFrozen(ir.steps)).toBe(true);
    expect(Object.isFrozen(ir.steps[0])).toBe(true);
    expect(Object.isFrozen(ir.steps[0]?.needs)).toBe(true);
    expect(Object.isFrozen(ir.roles)).toBe(true);
  });
});

describe("discovery", () => {
  it("prefers .argos and falls back to .paseo/plugins/playbooks per id", () => {
    const dir = join(FIXTURES, "discovery");
    const entries = discoverPlaybooks(dir);
    expect(entries.map((entry) => entry.id)).toStrictEqual(["alpha", "beta"]);
    expect(entries[0]?.root).toBe(".argos/playbooks");
    expect(entries[1]?.root).toBe(".paseo/plugins/playbooks");
    expect(loadPlaybook(dir, "alpha").title).toBe("Argos Alpha");
    expect(loadPlaybook(dir, "beta").title).toBe("Paseo Beta");
  });

  it("discovers role directories and script directories", () => {
    const roles = discoverRoles(COMPAT);
    expect(roles.map((role) => role.id)).toContain("implementer");
    expect(roles.find((role) => role.id === "implementer")?.instructionsFile).toContain("implementer");
    expect(discoverScripts(COMPAT)).toStrictEqual([]);
  });

  it("reports an unknown playbook id as playbook_missing", () => {
    try {
      loadPlaybook(COMPAT, "nope");
      throw new Error("expected loadPlaybook to throw");
    } catch (error) {
      expect(isArgosError(error)).toBe(true);
      if (!isArgosError(error)) return;
      expect(error.code).toBe("playbook_missing");
      expect(error.message).toContain("nope");
    }
  });

  it("loads an explicit file path", () => {
    const file = join(COMPAT, ".paseo/plugins/playbooks/pr.yaml");
    expect(readFileSync(file, "utf8")).toContain("title: Pull request");
    expect(loadPlaybook(COMPAT, "pr", { file }).title).toBe("Pull request");
  });
});
