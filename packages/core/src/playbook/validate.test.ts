import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../errors.js";
import { loadPlaybook } from "./load.js";

const INVALID = join(fileURLToPath(new URL("../../test/fixtures", import.meta.url)), "invalid");

interface Captured {
  readonly code: string;
  readonly stepId: string | undefined;
  readonly message: string;
  readonly file: string | undefined;
}

function capture(id: string): Captured {
  try {
    loadPlaybook(INVALID, id);
  } catch (error) {
    expect(isArgosError(error)).toBe(true);
    if (!isArgosError(error)) throw error;
    return {
      code: error.code,
      stepId: error.stepId,
      message: error.message,
      file: error.file,
    };
  }
  throw new Error(`fixture ${id} was expected to fail validation`);
}

describe("validatePlaybook: invalid fixtures", () => {
  it.each([
    { id: "unknown-needs", code: "playbook_invalid", stepId: "b", message: 'needs unknown step "ghost"' },
    {
      id: "unknown-target",
      code: "playbook_invalid",
      stepId: "a",
      message: 'on.success.goto targets unknown step "ghost"',
    },
    { id: "unknown-outcome", code: "playbook_invalid", stepId: "a", message: "is not an outcome" },
    { id: "unknown-role", code: "playbook_invalid", stepId: "a", message: 'unknown role "ghost"' },
    { id: "duplicate-id", code: "playbook_invalid", stepId: "dup", message: 'duplicate step id "dup"' },
    { id: "missing-prompt", code: "playbook_invalid", stepId: "a", message: "needs a `prompt`" },
    { id: "max-loops", code: "playbook_invalid", stepId: "a", message: ">=" },
    { id: "cycle", code: "playbook_cycle", stepId: "a", message: "a -> b -> a" },
  ])("$id -> exactly one $code naming step $stepId", ({ id, code, stepId, message }) => {
    const error = capture(id);
    expect(error.code).toBe(code);
    expect(error.stepId).toBe(stepId);
    expect(error.message).toContain(message);
    expect(error.file).toContain(`${id}.yaml`);
    expect(error.message.startsWith(`${error.file}: step ${stepId}: `)).toBe(true);
  });

  it("surfaces a schema failure as a playbook_invalid with the offending step", () => {
    const error = capture("max-loops");
    expect(error.message).toContain("steps.0.on.success");
    expect(error.message).toContain("max_loops");
  });
});
