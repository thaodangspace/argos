import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, argosHome } from "./index.js";

describe("argos-core", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("argos-core");
  });

  it("returns a non-empty home directory", () => {
    expect(argosHome().length).toBeGreaterThan(0);
  });
});
