import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook, type LoadWarning } from "./load.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const ROOT = join(FIXTURES, "aliases");

/**
 * The compatibility alias surface listed in `docs/compat.md` (FR6–FR10). `poll_ms`/`pollMs` are
 * covered by the rest of the suite; this fixture pins the paseo spellings that only appear in
 * real-world playbooks: flat `gate` + `choices`, flat `script` + `poll`, `playbook: {name}`,
 * and `mode_id`.
 */
describe("playbook compatibility aliases", () => {
  const ir = loadPlaybook(ROOT, "aliases");

  it("accepts a flat `gate:` string with step-level `choices`", () => {
    const gate = ir.steps.find((step) => step.id === "approve");
    expect(gate?.kind).toBe("gate");
    expect(gate?.gate?.question).toBe("Ship it?");
    expect(gate?.gate?.choices["approve"]?.label).toBe("approve");
    expect(gate?.gate?.choices["reject"]?.label).toBe("reject");
    expect(gate?.outcomes).toStrictEqual(["approve", "reject"]);
  });

  it("accepts a flat `script:` name and a `poll:` duration", () => {
    const script = ir.steps.find((step) => step.id === "publish");
    expect(script?.kind).toBe("script");
    expect(script?.script).toStrictEqual({ run: "publish.mjs", env: [] });
    expect(script?.pollMs).toBe(1_000);
  });

  it("accepts paseo's `playbook: { name }` sub-playbook spelling", () => {
    const block = ir.blocks["delegate"];
    expect(block?.playbookId).toBe("child");
    expect(block?.stepIds).toStrictEqual(["delegate.work"]);
    expect(ir.steps.map((step) => step.id)).toContain("delegate.work");
  });

  it("normalizes `mode_id` and `mode` to `modeId`", () => {
    const child = ir.steps.find((step) => step.id === "delegate.work");
    expect(child?.agent?.modeId).toBe("plan");
  });

  it("keeps the pre-expansion step order and a stable hash", () => {
    expect(ir.steps.map((step) => step.id)).toStrictEqual([
      "review",
      "approve",
      "publish",
      "delegate.work",
    ]);
    expect(loadPlaybook(ROOT, "aliases").hash).toBe(ir.hash);
  });

  it("pins the hash and warns about the deprecated spellings only (FR7.2, FR7.4)", () => {
    const warnings: LoadWarning[] = [];
    const loaded = loadPlaybook(ROOT, "aliases", { warnings });

    // Strict keys and the warnings sink never move the IR hash.
    expect(loaded.hash).toBe("6479f2932fa631c6e768469959b585f33104e434b40bbedba96fb9b73f15fcfa");
    expect(loaded.hash).toBe(ir.hash);
    expect(warnings.map((warning) => `${warning.stepId}:${warning.code}`)).toStrictEqual([
      "review:alias_deprecated",
      "work:alias_deprecated",
      "work:alias_deprecated",
    ]);
    expect(warnings.every((warning) => warning.file.startsWith(ROOT))).toBe(true);
    expect(warnings.map((warning) => warning.message).join("\n")).toContain('"poll_ms"');
    expect(warnings.map((warning) => warning.message).join("\n")).toContain('"mode_id"');
  });

  it("rejects `use` inside an after-task", () => {
    let error: unknown;
    try {
      loadPlaybook(ROOT, "after-use");
    } catch (cause) {
      error = cause;
    }
    expect(isArgosError(error)).toBe(true);
    expect(isArgosError(error) ? error.code : "").toBe("playbook_invalid");
    expect(isArgosError(error) ? error.message : "").toContain("not supported inside after-task");
  });

  it("rejects an unknown key in an Argos-only block (strict)", () => {
    let error: unknown;
    try {
      loadPlaybook(ROOT, "strict-agent");
    } catch (cause) {
      error = cause;
    }
    expect(isArgosError(error)).toBe(true);
    expect(isArgosError(error) ? error.code : "").toBe("playbook_invalid");
    expect(isArgosError(error) ? error.stepId : undefined).toBe("work");
  });
});
