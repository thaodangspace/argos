import { describe, expect, it } from "vitest";

import { ARGOS_ERROR_CODES, ArgosError, argosError, isArgosError } from "./errors.js";

describe("ArgosError", () => {
  it("names the file and step in the message and exposes them as fields", () => {
    const error = argosError(
      "playbook_invalid",
      { file: "/repo/.argos/playbooks/fix.yaml", stepId: "review" },
      "needs unknown step \"nope\"",
    );

    expect(error).toBeInstanceOf(ArgosError);
    expect(error.code).toBe("playbook_invalid");
    expect(error.file).toBe("/repo/.argos/playbooks/fix.yaml");
    expect(error.stepId).toBe("review");
    expect(error.message).toBe(
      '/repo/.argos/playbooks/fix.yaml: step review: needs unknown step "nope"',
    );
    expect(isArgosError(error)).toBe(true);
  });

  it("omits the step segment when there is none", () => {
    const error = argosError("playbook_missing", { file: "/repo/fix.yaml" }, "not found");
    expect(error.message).toBe("/repo/fix.yaml: not found");
  });

  it("does not treat a plain Error as an Argos error", () => {
    expect(isArgosError(new Error("boom"))).toBe(false);
    expect(isArgosError(undefined)).toBe(false);
    expect(isArgosError({ name: "ArgosError", code: "not_a_code" })).toBe(false);
  });

  it("keeps the stable code union closed", () => {
    const error = new ArgosError("playbook_cycle", "cycle", { stepId: "a" });
    expect(error.code).toBe("playbook_cycle");
    expect(error.stepId).toBe("a");
    expect(error.file).toBeUndefined();
  });

  it("names the schedule registry codes (FR1.6, FR1.7)", () => {
    expect(ARGOS_ERROR_CODES).toContain("schedule_unknown");
    expect(ARGOS_ERROR_CODES).toContain("schedule_exists");
    expect(isArgosError({ name: "ArgosError", code: "schedule_unknown" })).toBe(true);
  });
});
