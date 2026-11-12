/**
 * Regression: a global install (`npm i -g`, `npm link`, Homebrew prefix) runs the `argos` bin
 * through a symlink. `process.argv[1]` keeps that symlink path while `import.meta.url` is the
 * resolved module path, so the entry-point check must realpath both or the CLI exits silently.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const distIndex = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let directory: string | undefined;

afterEach(() => {
  if (directory === undefined) return;
  rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("bin entry", () => {
  it.skipIf(process.platform === "win32")(
    "runs the CLI when invoked through a symlink (global install / npm link)",
    () => {
      expect(existsSync(distIndex), "run `npm run build` first").toBe(true);
      directory = mkdtempSync(join(tmpdir(), "argos-entry-"));
      const link = join(directory, "argos");
      symlinkSync(distIndex, link);

      const result = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("argos validate");
    },
  );

  it("does not run the CLI when the module is imported", async () => {
    const module = await import("../src/index.js");
    expect(typeof module.runCli).toBe("function");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
