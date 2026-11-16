/**
 * The `hc` layer's structural promises (FR27, plan Phase 5 verification 4).
 *
 * Three claims are easier to test than to review:
 *
 * 1. `src/hc/client.ts` is the **only** file in the repository that opens a socket (`node:net`),
 *    and it never spawns a process (`node:child_process`) — hc is a terminal host, not a CLI.
 * 2. The two adapters stay independent: `src/hc` never imports `src/paseo` and vice versa, and
 *    neither reaches the engine, the playbook layer, or the durable host.
 * 3. The layer is a subpath, not part of the package root, so a CLI or plugin import of
 *    `@thaodangspace/argos-core` can never pull a socket in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const CORE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

/** Every `from "…"` / `import("…")` specifier in a source file. */
function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("hc isolation (FR27)", () => {
  it("imports node:net only from src/hc/client.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === join(SRC, "hc", "client.ts")) continue;
      if (importSpecifiers(readFileSync(file, "utf8")).some((name) => /^node:net$/.test(name))) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports node:child_process anywhere under src/hc", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, "hc"))) {
      if (importSpecifiers(readFileSync(file, "utf8")).some((name) => /^node:child_process$/.test(name))) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the two adapters independent and clear of the engine/playbook/durable layers", () => {
    const forbidden: readonly RegExp[] = [
      /^\.\.\/paseo\//,
      /^\.\.\/engine\//,
      /^\.\.\/playbook\//,
      /^\.\.\/durable\//,
      /^\.\.\/git\//,
      /^\.\.\/rpc\//,
      /^@getpaseo\//,
      /^node:sqlite$/,
      /^node:child_process$/,
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, "hc"))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${file.slice(SRC.length)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    const backReferences: string[] = [];
    for (const file of sourceFiles(join(SRC, "paseo"))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.includes("/hc/") || specifier.endsWith("/hc")) {
          backReferences.push(`${file.slice(SRC.length)}: ${specifier}`);
        }
      }
    }
    expect(backReferences).toEqual([]);
  });

  it("stays off the package root and is published as its own subpath", () => {
    const rootIndex = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(rootIndex).not.toMatch(/\.\/hc\/|hc\/index/);
    expect(rootIndex).not.toContain("node:net");
    const manifest = JSON.parse(readFileSync(join(CORE_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
      files?: readonly string[];
    };
    expect(manifest.exports?.["./hc"]).toEqual({
      types: "./dist/hc/index.d.ts",
      import: "./dist/hc/index.js",
    });
    expect(manifest.files).toContain("dist");
  });
});
