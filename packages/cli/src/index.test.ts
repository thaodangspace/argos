import { afterEach, describe, expect, it } from "vitest";

import { CLI_NAME, describeEnvironment } from "./index.js";

afterEach(() => {
  delete process.env["ARGOS_HOME"];
});

describe("argos-cli", () => {
  it("identifies itself", () => {
    expect(CLI_NAME).toBe("argos");
  });

  it("reads its home directory from argos-core", () => {
    process.env["ARGOS_HOME"] = "/tmp/argos-cli-test-home";
    expect(describeEnvironment()).toBe("argos home: /tmp/argos-cli-test-home");
  });
});
