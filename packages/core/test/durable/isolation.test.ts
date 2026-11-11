import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Every `.ts` file under a directory, recursively. */
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

describe("durable isolation (FR2/FR5)", () => {
  it("imports @earendil-works only from src/durable", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file.includes(`${join("src", "durable")}`)) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("@earendil-works/")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the durable surface on the subpath, not the package root", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const rootIndex = readFileSync(join(srcRoot, "index.ts"), "utf8");
    expect(rootIndex).not.toContain("durable");
    expect(rootIndex).not.toContain("@earendil-works/");
  });
});
