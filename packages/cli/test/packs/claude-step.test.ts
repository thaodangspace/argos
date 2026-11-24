/**
 * The `claude` pack's agent program (FR5–FR7, plan Phase 1). Every assertion is on *our* output —
 * OSC bytes, exit code, the screen tail after the clear, the JSONL log line — because a fake
 * `claude` replays the `stream-json` events the real CLI emits. No token, no network, no real
 * binary: the fake is the contract.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const program = fileURLToPath(new URL("../../templates/packs/claude/claude-step.mjs", import.meta.url));
const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

/** The OSC 7501 report the Python program sent, byte for byte. */
const osc = (state: string): string => `\u001b]7501;state=${state}\u001b\\`;
const CLEAR = "\u001b[3J\u001b[H\u001b[2J";
const PROMPT = "Ship the change.\n\nKeep the fence intact.\n";

interface Outcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

let home: string;
let stateDir: string;
let promptFile: string;
let fake: string;
let baseEnv: Readonly<Record<string, string>>;

beforeEach(() => {
  home = tempDir("argos-pack-home-");
  stateDir = tempDir("argos-pack-state-");
  // A fake login shell: the real one would run the developer's rc files on every spawn, and the
  // PATH probe is the only environment work the program does.
  const shell = join(home, "login-shell");
  writeFileSync(shell, "#!/bin/sh\nprintf '__ARGOS_PATH__=%s\\n' \"$FAKE_LOGIN_PATH\"\n", "utf8");
  chmodSync(shell, 0o755);
  // A copy, so the exec bit on the repo fixture cannot decide whether this suite runs.
  fake = join(tempDir("argos-pack-fake-"), "claude");
  copyFileSync(fakeClaude, fake);
  chmodSync(fake, 0o755);
  promptFile = join(tempDir("argos-pack-prompt-"), "prompt.txt");
  writeFileSync(promptFile, PROMPT, "utf8");
  baseEnv = {
    HOME: home,
    XDG_STATE_HOME: stateDir,
    ARGOS_HOME: tempDir("argos-pack-argos-"),
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    SHELL: shell,
    HC_TERMINAL_ID: "t-pack",
    FAKE_CLAUDE_MODE: "ok",
    FAKE_CLAUDE_STATE: join(stateDir, "fake-claude.json"),
  };
});

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function start(args: readonly string[], overrides: Readonly<Record<string, string>> = {}): ChildProcess {
  return spawn(process.execPath, [program, ...args], {
    env: { ...baseEnv, ...overrides },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function run(
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: Record<string, string> } = {},
): Promise<Outcome> {
  const startedAt = Date.now();
  const child = start(args, options.env ?? {});
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
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
    child.stdin?.end(options.stdin ?? "");
  });
}

/** The four flags a generated `claude-*` template passes, unchanged. */
const baseArgs = (): string[] => [
  "--model",
  "claude-opus-5-5",
  "--effort",
  "high",
  "--permission-mode",
  "auto",
  "--prompt-file",
  promptFile,
  "--claude",
  fake,
];

function logLines(): Array<Record<string, unknown>> {
  const file = join(stateDir, "argos-hc", "claude-step.log");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fakeState(): { attempts: number; pids: number[] } {
  return JSON.parse(readFileSync(join(stateDir, "fake-claude.json"), "utf8")) as {
    attempts: number;
    pids: number[];
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for a condition");
}

describe("claude-step.mjs", () => {
  it("reports idle → working → done, clears the screen, and leaves one fence", async () => {
    const outcome = await run(baseArgs());
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);

    const idle = outcome.stdout.indexOf(osc("idle"));
    const working = outcome.stdout.indexOf(osc("working"));
    const done = outcome.stdout.indexOf(osc("done"));
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(working).toBeGreaterThan(idle);
    expect(done).toBeGreaterThan(working);

    // Progress is what `hc attach --observe` shows: the session line, one per tool use, one per
    // non-empty assistant text block.
    expect(outcome.stdout).toContain("claude 999.0.0-fake · claude-opus-5-5 · session session-fake");
    expect(outcome.stdout).toContain("→ Bash ls -la");
    expect(outcome.stdout).toContain("· Reading the tree before the change");

    const tail = outcome.stdout.slice(outcome.stdout.lastIndexOf(CLEAR) + CLEAR.length);
    expect(tail.split("```json")).toHaveLength(2);
    expect(tail.split("```")).toHaveLength(3);
    expect(tail).toContain(`"promptLength":${PROMPT.trim().length}`);
    expect(tail).toContain(osc("done"));
  });

  it("exits 2 on a missing --model, a malformed duration, or a prompt that never arrives", async () => {
    const noModel = await run(["--prompt-file", promptFile, "--claude", fake]);
    expect(noModel.code).toBe(2);
    expect(noModel.stderr).toContain("--model is required");
    expect(noModel.stdout).toBe("");

    const badDuration = await run([
      "--model",
      "m",
      "--work-timeout",
      "1 hour",
      "--prompt-file",
      promptFile,
      "--claude",
      fake,
    ]);
    expect(badDuration.code).toBe(2);
    expect(badDuration.stderr).toContain("expected <n>[s|m|h]");

    // No tty and no --prompt-file: stdin is read to EOF, and an empty stdin is no prompt.
    const noPrompt = await run(["--model", "m", "--claude", fake], { stdin: "" });
    expect(noPrompt.code).toBe(2);
    expect(noPrompt.stderr).toContain("no prompt arrived");
    expect(noPrompt.stdout.indexOf(osc("idle"))).toBeLessThan(noPrompt.stdout.indexOf(osc("working")));
    expect(noPrompt.stdout).toContain(osc("done"));

    const unreadable = await run(["--model", "m", "--prompt-file", join(home, "nope.txt")]);
    expect(unreadable.code).toBe(2);
  });

  it("waits out a quota hit and then succeeds", async () => {
    const outcome = await run(
      [...baseArgs(), "--quota-retry", "1s", "--quota-max-wait", "2s"],
      { env: { FAKE_CLAUDE_MODE: "quota-once" } },
    );
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
    // The reset time is known, so the wait is capped by --quota-max-wait, not --quota-retry.
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(outcome.stdout).toContain("```json");
    expect(fakeState().attempts).toBe(2);
    expect(logLines().map((line) => line["status"])).toEqual(["quota_wait", "success"]);
  });

  it("gives up with 75 when the quota outlasts --quota-max-wait", async () => {
    const outcome = await run([...baseArgs(), "--quota-max-wait", "0s"], {
      env: { FAKE_CLAUDE_MODE: "quota-once" },
    });
    expect(outcome.code).toBe(75);
    expect(outcome.stdout).toContain(osc("done"));
    expect(logLines().map((line) => line["status"])).toContain("quota_exhausted");
  });

  it("kills the group at --work-timeout and exits 124", async () => {
    const outcome = await run([...baseArgs(), "--work-timeout", "1s"], {
      env: { FAKE_CLAUDE_MODE: "hang" },
    });
    expect(outcome.code).toBe(124);
    expect(outcome.stdout).toContain(osc("done"));
    expect(logLines().map((line) => line["status"])).toContain("timeout");
    const [pid] = fakeState().pids;
    expect(pid).toBeDefined();
    expect(isAlive(pid ?? 0)).toBe(false);
  });

  it("exits with claude's own code when the run fails", async () => {
    const failed = await run(baseArgs(), { env: { FAKE_CLAUDE_MODE: "fail" } });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("claude failed (exit 1, error_max_turns)");
    expect(failed.stdout).toContain(osc("done"));
    expect(failed.stdout).not.toContain(CLEAR);

    const exit3 = await run(baseArgs(), { env: { FAKE_CLAUDE_MODE: "exit3" } });
    expect(exit3.code).toBe(3);
  });

  it("exits 1 when claude exits 0 without ever reporting a result", async () => {
    // Parity with the Python program's `exit_code or 1`: a zero exit with no result is a failure.
    const silent = join(tempDir("argos-pack-silent-"), "claude");
    writeFileSync(silent, "#!/bin/sh\ncat >/dev/null\nexit 0\n", "utf8");
    chmodSync(silent, 0o755);
    const outcome = await run(["--model", "m", "--prompt-file", promptFile, "--claude", silent]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("no result");
    expect(outcome.stdout).toContain(osc("done"));
    expect(outcome.stdout).not.toContain(CLEAR);
  });

  it("logs one JSONL line with the documented fields and no prompt text", async () => {
    const outcome = await run(baseArgs());
    expect(outcome.code).toBe(0);

    const lines = logLines();
    expect(lines).toHaveLength(1);
    const [entry] = lines;
    if (!entry) throw new Error("no log line");
    expect(Object.keys(entry).sort()).toEqual([
      "at",
      "cost_usd",
      "cwd",
      "seconds",
      "session",
      "status",
      "terminal",
      "turns",
    ]);
    expect(entry["status"]).toBe("success");
    expect(entry["terminal"]).toBe("t-pack");
    expect(entry["session"]).toBe("session-fake");
    expect(entry["cost_usd"]).toBe(0.01);
    expect(entry["turns"]).toBe(2);
    expect(typeof entry["seconds"]).toBe("number");
    expect(typeof entry["at"]).toBe("string");

    // The log never carries the prompt; only the run cwd, which is inside the temp tree here.
    const text = readFileSync(join(stateDir, "argos-hc", "claude-step.log"), "utf8");
    expect(text).not.toContain("Ship the change");
    expect(text).not.toContain(promptFile);
    expect(statSync(join(stateDir, "argos-hc")).mode & 0o777).toBe(0o700);
  });

  it("honours --log over the XDG state path", async () => {
    const file = join(tempDir("argos-pack-log-"), "nested", "run.log");
    const outcome = await run([...baseArgs(), "--log", file]);
    expect(outcome.code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain('"status":"success"');
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", async () => {
    const env = { ...baseEnv, XDG_STATE_HOME: "" };
    const outcome = await run(baseArgs(), { env });
    expect(outcome.code).toBe(0);
    const file = join(home, ".local", "state", "argos-hc", "claude-step.log");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain('"status":"success"');
  });

  it("treats SIGTERM as a kill: the group dies and the report is done", async () => {
    const child = start([...baseArgs(), "--work-timeout", "60m"], { FAKE_CLAUDE_MODE: "hang" });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin?.end("");

    await waitFor(() => stdout.includes(osc("working")));
    await waitFor(() => existsSync(join(stateDir, "fake-claude.json")));
    const [pid] = fakeState().pids;
    expect(pid).toBeDefined();
    child.kill("SIGTERM");

    expect(await closed).toEqual({ code: 143, signal: null });
    expect(stdout).toContain(osc("done"));
    expect(isAlive(pid ?? 0)).toBe(false);
  });

  it("resolves claude from the login shell's PATH", async () => {
    // A `claude` on the probed PATH is what hc's minimal environment needs to find.
    const bin = tempDir("argos-pack-bin-");
    const installed = join(bin, "claude");
    copyFileSync(fake, installed);
    chmodSync(installed, 0o755);
    const args = ["--model", "claude-opus-5-5", "--prompt-file", promptFile];
    const outcome = await run(args, { env: { FAKE_LOGIN_PATH: bin } });
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("claude 999.0.0-fake");
  });
});
