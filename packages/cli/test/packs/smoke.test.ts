/**
 * The `smoke` pack's program: the zero-cost proof of the whole hc chain (plan Phase 1). It must
 * emit `idle` before it reads, answer with exactly one fenced JSON block, report `done`, and exit
 * 0 — and refuse a prompt it never got.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const program = fileURLToPath(new URL("../../templates/packs/smoke/smoke.mjs", import.meta.url));
const osc = (state: string): string => `\u001b]7501;state=${state}\u001b\\`;

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

let promptFile: string;

beforeEach(() => {
  promptFile = join(tempDir("argos-smoke-"), "prompt.txt");
  writeFileSync(promptFile, "hello smoke\n", "utf8");
});

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: readonly string[], stdin = ""): Promise<Outcome> {
  const child = spawn(process.execPath, [program, ...args], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin?.end(stdin);
  });
}

describe("smoke.mjs", () => {
  it("reads the prompt, answers with one fenced block, and exits 0", async () => {
    const outcome = await run(["--prompt-file", promptFile]);
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);

    const idle = outcome.stdout.indexOf(osc("idle"));
    const working = outcome.stdout.indexOf(osc("working"));
    const done = outcome.stdout.indexOf(osc("done"));
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(working).toBeGreaterThan(idle);
    expect(done).toBeGreaterThan(working);

    expect(outcome.stdout.split("```json")).toHaveLength(2);
    expect(outcome.stdout.split("```")).toHaveLength(3);
    // "hello smoke" — trimmed, so the count is the prompt the terminal actually delivered.
    expect(outcome.stdout).toContain('{"ok":true,"promptLength":11}');
    // The block is the whole screen: nothing else may look like the result.
    expect(outcome.stdout.replace(/\u001b\]7501;state=\w+\u001b\\/g, "").trim()).toBe(
      '```json\n{"ok":true,"promptLength":11}\n```',
    );
  });

  it("exits 2 on an unknown argument, no prompt, or an unreadable prompt file", async () => {
    const extra = await run(["--prompt-file", promptFile, "--verbose"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("usage: smoke.mjs");

    const noPrompt = await run([], "");
    expect(noPrompt.code).toBe(2);
    expect(noPrompt.stderr).toContain("no prompt arrived");
    expect(noPrompt.stdout).toContain(osc("idle"));
    expect(noPrompt.stdout).toContain(osc("done"));

    const unreadable = await run(["--prompt-file", join(tempDir("argos-smoke-"), "missing.txt")]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.stderr).toContain("missing.txt");
  });
});
