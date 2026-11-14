/**
 * Import-graph guard (FR28, plan Phase 9 verification): the plugin is a thin RPC client.
 *
 * No file under `server/` or `shared/` (nor either entry point) may reach storage, git, the Paseo adapter, the durable
 * host, the RPC *server*, SQLite, or the filesystem API. The only `@thaodangspace\/argos-core` subpath allowed is
 * `@thaodangspace\/argos-core/rpc` (contracts + client), which itself imports no durable code.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
  }
  return files;
}

const pluginSources = [
  ...sourceFiles(join(pluginRoot, "server")),
  ...sourceFiles(join(pluginRoot, "shared")),
  ...sourceFiles(join(pluginRoot, "client")),
  join(pluginRoot, "index.server.ts"),
  join(pluginRoot, "index.client.tsx"),
];

/** Every `from "…"` / `import("…")` specifier in a source file. */
function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe("plugin import graph", () => {
  it("has source files to check", () => {
    expect(pluginSources.length).toBeGreaterThanOrEqual(6);
  });

  it("never imports storage, git, the Paseo adapter, the durable host, or the RPC server", () => {
    const forbidden = [
      /^@thaodangspace\/argos-core\/durable/,
      /^@thaodangspace\/argos-core\/git/,
      /^@thaodangspace\/argos-core\/paseo/,
      /^@thaodangspace\/argos-core\/engine/,
      /^@thaodangspace\/argos-core\/playbook/,
      /^@thaodangspace\/argos-core\/rpc\/server/,
      /^@thaodangspace\/argos-core$/,
      /^@earendil-works\//,
      /^node:sqlite$/,
      /^node:child_process$/,
    ];
    const offenders: string[] = [];
    for (const file of pluginSources) {
      // Only the server half may touch the filesystem (it reads `$ARGOS_HOME/token`); the shared
      // and client bundles run inside Paseo and must stay portable.
      const serverOnly = file.includes(`${pluginRoot}server${sep}`);
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) continue;
        if (serverOnly && /^node:fs/.test(specifier)) continue;
        for (const pattern of forbidden) {
          if (pattern.test(specifier)) offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only uses the shared RPC subpath for @thaodangspace\/argos-core", () => {
    const offenders: string[] = [];
    for (const file of pluginSources) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith("@thaodangspace/argos-core")) continue;
        if (!/^@thaodangspace\/argos-core\/rpc(\/contracts)?$/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps its non-relative imports to the Paseo SDK, React, zod, and the RPC contract", () => {
    const allowed = [
      /^@thaodangspace\/argos-core\/rpc(\/contracts)?$/,
      /^@getpaseo\//,
      /^react$/,
      /^zod$/,
    ];
    const offenders: string[] = [];
    for (const file of pluginSources) {
      // The Paseo client host hands its own `react-native` to client code (native on mobile,
      // react-native-web on desktop); the server half runs in the daemon and must not import it.
      const clientOnly =
        file.includes(`${pluginRoot}client${sep}`) || file === join(pluginRoot, "index.client.tsx");
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        if (clientOnly && specifier === "react-native") continue;
        if (!allowed.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("renders the client half without DOM elements (Paseo mobile is native React Native)", () => {
    const clientSources = [
      ...sourceFiles(join(pluginRoot, "client")),
      join(pluginRoot, "index.client.tsx"),
    ].filter((file) => file.endsWith(".tsx"));
    const offenders: string[] = [];
    for (const file of clientSources) {
      // A lowercase JSX tag is a DOM element: `<div`, `<span>`, `<button …`. A `<` right after an
      // identifier is a type argument (`useState<string | null>`), not a tag.
      for (const match of readFileSync(file, "utf8").matchAll(/(?<![\w$.])<([a-z][a-z0-9]*)(?=[\s>/])/g)) {
        offenders.push(`${file}: <${match[1]}>`);
      }
    }
    expect(clientSources.length).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
  });

  it("declares @thaodangspace\/argos-core as a workspace dependency and no storage dependency", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const core = JSON.parse(readFileSync(join(pluginRoot, "..", "core", "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.dependencies?.["@thaodangspace\/argos-core"]).toBe(core.version);
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all)).not.toContain("@earendil-works/pi-durable");
    expect(Object.keys(all)).not.toContain("@earendil-works/chord");
  });
});
