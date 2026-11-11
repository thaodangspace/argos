/**
 * Phase 7 import guard (D9, FR22).
 *
 * Two promises are structural, so they are tested structurally: git runs through
 * `execFile("git", [...])` with no shell, and the only modules that may start a process at all are
 * `src/git/*` and the `argos.script` task. A future `exec("git ...")`, `shell: true`, or a
 * convenient `child_process` import somewhere else fails here, not in a code review.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const ALLOWED = [join("src", "git", ""), join("src", "durable", "tasks", "script.ts")];

function isAllowed(file: string): boolean {
  const relative = file.slice(SRC.length - "src".length);
  return ALLOWED.some((prefix) =>
    prefix.endsWith(".ts") ? relative === prefix : relative.startsWith(prefix),
  );
}

describe("process isolation (D9)", () => {
  it("imports node:child_process only from src/git/** and the argos.script task", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (isAllowed(file)) continue;
      if (/from\s+["']node:child_process["']/.test(readFileSync(file, "utf8"))) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never asks for a shell and never builds a shell command string", () => {
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      const relative = file.slice(SRC.length);
      expect(source, `${relative}: shell: true`).not.toMatch(/shell:\s*true/);
      // `execFile` is the only allowed launcher; the shell variants (`exec`, `execSync`) are not.
      // `regex.exec(` is a member call and is not what this guards.
      expect(source, `${relative}: exec(`).not.toMatch(/(?<![.$\w])exec(Sync)?\s*\(/);
      expect(source, `${relative}: spawn with a shell`).not.toMatch(
        /spawn(Sync)?\([^)]*shell:\s*["']/,
      );
    }
  });

  it("keeps the git surface off the package root", () => {
    const rootIndex = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(rootIndex).not.toContain("git/index");
    expect(rootIndex).not.toContain("child_process");
  });

  it("runs every git command through the execFile runner with an argv array", () => {
    for (const name of ["worktree.ts", "snapshot.ts"]) {
      const source = readFileSync(join(SRC, "git", name), "utf8");
      // No shell strings: `git` is always the first element of an args array.
      expect(source, name).not.toMatch(/exec\s*\(\s*[`"']git /);
      expect(source, name).toContain("args:");
    }
  });
});
