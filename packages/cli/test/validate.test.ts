/**
 * `argos validate` exit codes and diagnostics (Phase 8 verification): valid fixtures exit 0;
 * every invalid fixture exits 2 and prints the file and step the loader blamed.
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ValidateReport } from "argos-core/rpc";

import { runCli } from "../src/main.js";
import { capture } from "./support/cli.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const compatDir = join(root, "core", "test", "fixtures", "compat", ".paseo", "plugins", "playbooks");
const invalidDir = join(root, "core", "test", "fixtures", "invalid");
const invalidPlaybookDir = join(invalidDir, ".argos", "playbooks");
const precedenceDir = join(root, "core", "test", "fixtures", "precedence");

describe("argos validate", () => {
  it("exits 0 for the compat and precedence fixtures", async () => {
    for (const directory of [compatDir, precedenceDir]) {
      const captured = capture();
      const code = await runCli(["validate", directory], captured.io);
      expect(code, captured.stdout() + captured.stderr()).toBe(0);
      expect(captured.stdout()).toContain("valid");
    }
  });

  it("prints the file and step for every invalid fixture", async () => {
    const fixtures = readdirSync(invalidPlaybookDir)
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    for (const name of fixtures) {
      const captured = capture();
      const code = await runCli(["validate", join(invalidPlaybookDir, name)], captured.io);
      const output = captured.stdout() + captured.stderr();
      expect(code, `${name}: ${output}`).toBe(2);
      expect(output).toContain(name === "cycle.yaml" ? "playbook_cycle" : "playbook_invalid");
      expect(output).toMatch(/step [a-z]/);
      expect(output).toContain(".argos/playbooks/");
    }
  });

  it("reports every invalid playbook in a directory in one run", async () => {
    const captured = capture();
    const code = await runCli(["validate", invalidDir, "--json"], captured.io);
    expect(code).toBe(2);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(false);
    expect(report.playbooks).toEqual([]);
    expect(report.errors.length).toBeGreaterThanOrEqual(8);
    for (const error of report.errors) {
      expect(error.code).toMatch(/^playbook_/);
      expect(error.stepId).not.toBeNull();
      expect(error.file).toContain(".argos/playbooks/");
    }
  });

  it("validates a single file with its repository root inferred", async () => {
    const captured = capture();
    const code = await runCli(
      ["validate", join(compatDir, "pr.yaml"), "--json"],
      captured.io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(captured.stdout()) as ValidateReport;
    expect(report.valid).toBe(true);
    expect(report.playbooks).toEqual([
      { id: "pr", file: `.paseo/plugins/playbooks/${basename("pr.yaml")}`, hash: expect.any(String) },
    ]);
  });

  it("fails with exit 1 for a missing path", async () => {
    const captured = capture();
    const code = await runCli(["validate", "/definitely/not/here"], captured.io);
    expect(code).toBe(1);
    expect(captured.stderr()).toContain("path not found");
  });
});
