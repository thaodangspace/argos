/** CLI test plumbing: captured IO, a temp home + token, environment save/restore, JSON scrubbing. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliIo } from "../../src/output.js";

export interface Captured {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

export function capture(): Captured {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

export interface TempHome {
  readonly home: string;
  cleanup(): void;
}

export function makeTempHome(token = "cli-test-token"): TempHome {
  const home = mkdtempSync(join(tmpdir(), "argos-cli-"));
  writeFileSync(join(home, "token"), `${token}\n`, { mode: 0o600 });
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Set `ARGOS_HOME`/`ARGOS_PORT` for one test and restore them afterwards. */
export function withEnv(values: Readonly<Record<string, string>>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Replace volatile doctor fields with stable markers so a golden file can be committed. */
export function scrubVolatile(
  value: unknown,
  context: { readonly home?: string; readonly port?: number; readonly pid?: number; readonly node?: string },
): unknown {
  const replacements: Array<[string, string]> = [];
  if (context.home !== undefined) replacements.push([context.home, "<home>"]);
  if (context.port !== undefined) replacements.push([`:${context.port}`, ":<port>"]);
  if (context.node !== undefined) replacements.push([context.node, "<node>"]);
  if (context.node !== undefined) replacements.push([`v${context.node}`, "v<node>"]);
  if (context.pid !== undefined) replacements.push([String(context.pid), "<pid>"]);

  const visit = (input: unknown, key: string | undefined): unknown => {
    if (Array.isArray(input)) return input.map((item) => visit(item, undefined));
    if (input !== null && typeof input === "object") {
      const result: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(input)) result[name] = visit(item, name);
      return result;
    }
    if (typeof input === "string") {
      let text = input;
      for (const [from, to] of replacements) text = text.split(from).join(to);
      return text;
    }
    if (typeof input === "number") {
      if (key === "port" || key === "pid" || key === "uptimeMs") return 0;
    }
    return input;
  };
  return visit(value, undefined);
}
