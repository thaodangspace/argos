/**
 * The bundled pack assets (FR5, FR8; plan Phase 1). They live outside the TypeScript graph on
 * purpose (D8), so this suite is their guard: every program must parse, import only `node:*`, and
 * the pack data must carry today's template flags and limits, byte-reproducibly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const templates = fileURLToPath(new URL("../../templates", import.meta.url));
const packsDir = join(templates, "packs");

interface PackTemplate {
  readonly name: string;
  readonly args: string;
  readonly minStepTimeoutMs: number;
  readonly description?: string;
}

interface Pack {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly requires: { readonly node: string; readonly hcProtocol?: number };
  readonly program: { readonly file: string };
  readonly templates: readonly PackTemplate[];
}

function walk(directory: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, suffix));
    else if (entry.endsWith(suffix)) found.push(path);
  }
  return found;
}

function readPack(name: string): { readonly file: string; readonly text: string; readonly pack: Pack } {
  const file = join(packsDir, name, "pack.json");
  const text = readFileSync(file, "utf8");
  return { file, text, pack: JSON.parse(text) as Pack };
}

/** The four templates in use today, with the flags and the limits that must not drift. */
const CLAUDE_TEMPLATES: readonly PackTemplate[] = [
  {
    name: "claude-opus-high",
    args: "--model claude-opus-5-5 --effort high --permission-mode auto --work-timeout 150m --quota-retry 30m --quota-max-wait 4h",
    minStepTimeoutMs: 19_800_000,
  },
  {
    name: "claude-opus-xhigh",
    args: "--model claude-opus-5-5 --effort xhigh --permission-mode auto --work-timeout 60m --quota-retry 30m --quota-max-wait 8h",
    minStepTimeoutMs: 33_300_000,
  },
  {
    name: "claude-sonnet-medium",
    args: "--model claude-sonnet-5-5 --effort medium --permission-mode auto --work-timeout 150m --quota-retry 30m --quota-max-wait 4h",
    minStepTimeoutMs: 19_800_000,
  },
  {
    name: "claude-fable-high",
    args: "--model claude-fable-5-2 --effort high --permission-mode auto --work-timeout 180m --quota-retry 30m --quota-max-wait 4h",
    minStepTimeoutMs: 26_100_000,
  },
];

const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,31}$/;

describe("bundled pack assets", () => {
  it("every pack program passes `node --check`", () => {
    const programs = walk(templates, ".mjs");
    expect(programs.length).toBeGreaterThanOrEqual(2);
    for (const file of programs) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(result.status, `${relative(templates, file)}: ${result.stderr}`).toBe(0);
    }
  });

  it("every pack program stands alone: imports only node: builtins", () => {
    for (const file of walk(templates, ".mjs")) {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(
        (match) => match[1] ?? "",
      );
      expect(specifiers.length, `${relative(templates, file)} imports nothing`).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
      // FR5: the program reads no ARGOS_* name (`__ARGOS_PATH__` is its own probe marker).
      expect(source.replaceAll("__ARGOS_PATH__", "").match(/ARGOS_[A-Z_]+/g)).toBeNull();
    }
  });

  it("every pack.json is canonical JSON: no timestamps, byte-identical on reinstall", () => {
    for (const name of readdirSync(packsDir)) {
      const { file, text, pack } = readPack(name);
      // Canonical form: two-space indent, key order preserved, trailing LF. An install writes
      // exactly this, so a second install (or a no-op `--dry-run`) produces an empty diff.
      const first = `${JSON.stringify(pack, null, 2)}\n`;
      const second = `${JSON.stringify(JSON.parse(text) as Pack, null, 2)}\n`;
      expect(text, relative(packsDir, file)).toBe(first);
      expect(second).toBe(first);
      expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)).toBe(false);
      expect(Object.keys(pack)).not.toContain("installedAt");
    }
  });

  it("the claude pack carries today's four templates and their limits", () => {
    const { pack } = readPack("claude");
    expect(pack.name).toBe("claude");
    expect(pack.version).toBe(1);
    expect(pack.requires.node).toBe(">=22.13");
    expect(pack.requires.hcProtocol).toBe(1);
    expect(pack.program.file).toBe("claude-step.mjs");
    expect(existsSync(join(packsDir, "claude", pack.program.file))).toBe(true);
    expect(
      pack.templates.map((template) => ({
        name: template.name,
        args: template.args,
        minStepTimeoutMs: template.minStepTimeoutMs,
      })),
    ).toEqual(CLAUDE_TEMPLATES);
    for (const template of pack.templates) {
      expect(template.name).toMatch(NAME_RULE);
      expect(template.args).toContain(`--model`);
      expect(template.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("the smoke pack carries one zero-cost template", () => {
    const { pack } = readPack("smoke");
    expect(pack.name).toBe("smoke");
    expect(pack.version).toBe(1);
    expect(pack.requires.node).toBe(">=22.13");
    expect(pack.program.file).toBe("smoke.mjs");
    expect(existsSync(join(packsDir, "smoke", pack.program.file))).toBe(true);
    expect(pack.templates.map((template) => template.name)).toEqual(["smoke"]);
    const [template] = pack.templates;
    if (!template) throw new Error("smoke pack has no template");
    expect(template.args).toBe("");
    expect(template.minStepTimeoutMs).toBe(300_000);
    expect(template.name).toMatch(NAME_RULE);
  });
});
