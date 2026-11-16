/**
 * The `hc` layer's structural promises (FR27, plan Phase 5 verification 4 and Phase 6).
 *
 * Four claims are easier to test than to review:
 *
 * 1. `src/hc/client.ts` is the **only** file in the repository that opens a socket (`node:net`),
 *    and it never spawns a process (`node:child_process`) — hc is a terminal host, not a CLI.
 * 2. The two adapters stay independent: `src/hc` never *runs* anything from `src/paseo`, and
 *    `src/paseo` never mentions `hc`. The structured-result parser both adapters share lives in the
 *    neutral `src/executor/output.ts`, and `src/paseo/output.ts` re-exports it, so hc has no reason
 *    to import a Paseo module at runtime.
 * 3. The adapter still speaks the durable host's port and the playbook IR — but only as **types**:
 *    `import type` of `../durable/context.js` and `../playbook/ir.js` is the whole allowance. A
 *    runtime import of the durable task layer, the playbook loader, the engine, git, or RPC would
 *    make the adapter depend on Argos' control path, which is exactly what the port exists to
 *    prevent.
 * 4. The layer is a subpath, not part of the package root, so a CLI or plugin import of
 *    `@thaodangspace/argos-core` can never pull a socket in.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const CORE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The only type-only imports `src/hc` may make outside the adapter itself. */
const ALLOWED_TYPE_IMPORTS: readonly string[] = [
  "../durable/context.js",
  "../playbook/ir.js",
];

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

/**
 * Every `import type … from "x"` specifier: those statements are erased by the compiler, so they
 * cannot pull runtime code (or a socket) into the adapter.
 */
function typeOnlySpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const statements = text.matchAll(
    /^[ \t]*(?:import|export)\s+type\s+[\s\S]*?\bfrom\s+["']([^"']+)["']/gm,
  );
  for (const match of statements) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Every specifier the module actually loads at runtime (`import type` statements removed). */
function runtimeSpecifiers(text: string): string[] {
  const withoutTypes = text.replace(
    /^[ \t]*(?:import|export)\s+type\s+[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm,
    "",
  );
  return importSpecifiers(withoutTypes);
}

function hcFiles(): string[] {
  return sourceFiles(join(SRC, "hc"));
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
    for (const file of hcFiles()) {
      if (importSpecifiers(readFileSync(file, "utf8")).some((name) => /^node:child_process$/.test(name))) {
        offenders.push(file.slice(SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports a Paseo module at runtime (the shared parser is executor-neutral)", () => {
    const offenders: string[] = [];
    for (const file of hcFiles()) {
      for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
        if (/^\.\.\/paseo\//.test(specifier)) offenders.push(`${file.slice(SRC.length)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches the host and the IR as types only, and nothing else outside src/hc", () => {
    const forbiddenRuntime: readonly RegExp[] = [
      /^\.\.\/durable\//,
      /^\.\.\/playbook\//,
      /^\.\.\/engine\//,
      /^\.\.\/git\//,
      /^\.\.\/rpc\//,
      /^\.\.\/paseo\//,
      /^@getpaseo\//,
      /^node:sqlite$/,
      /^node:child_process$/,
    ];
    /** Layers a type-only import may name: the port it implements and the IR it reads. */
    const typedLayers: readonly RegExp[] = [
      /^\.\.\/durable\//,
      /^\.\.\/playbook\//,
      /^\.\.\/engine\//,
      /^\.\.\/git\//,
      /^\.\.\/rpc\//,
      /^\.\.\/paseo\//,
    ];
    const runtimeOffenders: string[] = [];
    const typeOffenders: string[] = [];
    for (const file of hcFiles()) {
      const text = readFileSync(file, "utf8");
      for (const specifier of runtimeSpecifiers(text)) {
        if (forbiddenRuntime.some((pattern) => pattern.test(specifier))) {
          runtimeOffenders.push(`${file.slice(SRC.length)}: ${specifier}`);
        }
      }
      for (const specifier of typeOnlySpecifiers(text)) {
        if (
          typedLayers.some((pattern) => pattern.test(specifier)) &&
          !ALLOWED_TYPE_IMPORTS.includes(specifier)
        ) {
          typeOffenders.push(`${file.slice(SRC.length)}: ${specifier}`);
        }
      }
    }
    expect(runtimeOffenders).toEqual([]);
    expect(typeOffenders).toEqual([]);

    // And the promise is used, not just permitted: the executor implements the host's port.
    const executor = readFileSync(join(SRC, "hc", "agent-step.ts"), "utf8");
    expect(executor).toContain('from "../durable/context.js"');
    expect(executor).toContain('from "../executor/output.js"');
  });

  it("keeps the two adapters from referring to each other", () => {
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
