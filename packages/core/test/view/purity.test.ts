/**
 * The view model is shared by two clients, so it must stay free of the runtime it projects (spec
 * FR6): no Node built-in, no storage, no adapter, no engine. This test is the guard.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const viewDir = fileURLToPath(new URL("../../src/view", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return entry.endsWith(".ts") ? [path] : [];
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

describe("view purity", () => {
  const files = sourceFiles(viewDir);

  it("has the modules to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("imports neither Node built-ins nor a runtime module", () => {
    const forbidden = [
      /^node:/,
      /^@earendil-works\//,
      /^@getpaseo\//,
      /^zod$/,
      /^\.\.\/(durable|paseo|hc|git|engine|playbook)\//,
      /^(\.\.\/)+(durable|paseo|hc|git|engine|playbook)\//,
      /^\.\/(server|client|rpc\/server)/,
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

  it("only depends on the RPC contract and its own modules", () => {
    const allowed = [/^\.\.\/rpc\/contracts\.js$/, /^\.\/[a-z-]+\.js$/];
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!allowed.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
