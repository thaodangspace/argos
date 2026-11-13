/**
 * Import-graph guard (FR2/FR3): the CLI is an HTTP client. Only `commands/serve.ts` may reach the
 * one-storage-owner module (`@thaodangspace\/argos-core/rpc/server`), and no CLI source may import the durable host,
 * the git port, the SQLite driver, or a `@earendil-works/*` package.
 *
 * The core `@thaodangspace\/argos-core/rpc` barrel is checked too: it must stay importable by the CLI/plugin without
 * pulling durable code.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const cliSource = join(cliRoot, "src");
const coreRpc = fileURLToPath(new URL("../../core/src/rpc", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("CLI import graph", () => {
  it("never imports the durable host, git, SQLite, or an @earendil-works package", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(cliSource)) {
      const text = readFileSync(file, "utf8");
      const forbidden = [
        /from\s+["']@thaodangspace\/argos-core\/durable/,
        /from\s+["']@thaodangspace\/argos-core\/git/,
        /["']node:sqlite["']/,
        /from\s+["']@earendil-works\//,
      ];
      for (const pattern of forbidden) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches @thaodangspace\/argos-core/rpc/server only from commands/serve.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(cliSource)) {
      if (file.endsWith(join("commands", "serve.ts"))) continue;
      if (/from\s+["']@thaodangspace\/argos-core\/rpc\/server["']/.test(readFileSync(file, "utf8"))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the @thaodangspace\/argos-core/rpc barrel free of durable imports", () => {
    for (const name of ["index.ts", "contracts.ts", "client.ts"]) {
      const text = readFileSync(join(coreRpc, name), "utf8");
      expect(text, name).not.toMatch(/from\s+["']\.\.\/durable\//);
    }
    // `summary.ts` is server-side only (not in the barrel), but it may only type-import durable.
    const summary = readFileSync(join(coreRpc, "summary.ts"), "utf8");
    expect(summary).toMatch(/import type \{[^}]*\} from "\.\.\/durable\/mirror\.js"/);
  });

  it("ships an executable entry with a shebang", () => {
    const entry = join(cliRoot, "dist", "index.js");
    const source = readFileSync(join(cliSource, "index.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin?.["argos"]).toBe("dist/index.js");
    if (statSync(entry, { throwIfNoEntry: false }) !== undefined) {
      expect((statSync(entry).mode & 0o111) !== 0).toBe(true);
    }
  });
});
