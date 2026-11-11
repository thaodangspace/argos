import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Every `.ts` file under a directory, recursively (test files excluded: they never import the SDK). */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("paseo isolation (FR2/FR5)", () => {
  it("imports @getpaseo/* only from src/paseo/client.ts", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const allowed = join("src", "paseo", "client.ts");
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file.endsWith(allowed)) continue;
      if (/from\s+["']@getpaseo\//.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the paseo surface on the subpath, not the package root", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const rootIndex = readFileSync(join(srcRoot, "index.ts"), "utf8");
    expect(rootIndex).not.toContain("paseo");
    expect(rootIndex).not.toContain("@getpaseo/");
  });
});
