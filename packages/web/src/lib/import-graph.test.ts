/**
 * Import-graph guard for the web app (spec FR6): a browser bundle can only reach the contract and
 * the shared view model. Storage, the durable host, the Paseo/hc adapters, the engine, the loader,
 * and the RPC server must never be reachable from `packages/web/src`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!entry.endsWith(".ts") && !entry.endsWith(".svelte")) return [];
    return [path];
  });
}

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("web import graph", () => {
  // The two guards read the tree with `node:fs`; they are metadata about the bundle, never part of
  // it, so they are the only files this rule excuses.
  const guardFiles = ["import-graph.test.ts", "style-guard.test.ts"];
  const files = sourceFiles(srcDir).filter(
    (file) => !guardFiles.some((name) => file.endsWith(name)),
  );

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("uses only the shared contract and view subpaths from core", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith("@thaodangspace/argos-core")) continue;
        if (!/^@thaodangspace\/argos-core\/(rpc\/contracts|view)$/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports storage, a socket, a child process, or an adapter", () => {
    const forbidden = [
      /^@earendil-works\//,
      /^@getpaseo\//,
      /^node:sqlite$/,
      /^node:net$/,
      /^node:child_process$/,
      /^node:fs/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        for (const pattern of forbidden) {
          if (pattern.test(specifier)) offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
