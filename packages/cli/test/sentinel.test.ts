/**
 * The Phase 8 sentinel: a real `argos serve` child owns the database; a separate `argos run` child
 * must never load SQLite, the durable host, or open `argos.sqlite`. A preload throws on every such
 * attempt, so a clean `argos run` proves the CLI stayed an HTTP client (FR3).
 *
 * Also checks: the server survives the client run, `argos doctor` sees the live server, and a second
 * `argos serve` on the same home fails `storage_locked` naming the pid file.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { DoctorReport, RunDetail } from "argos-core/rpc";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const distIndex = join(cliRoot, "dist", "index.js");

const PRELOAD = `
const Module = require("node:module");
const fs = require("node:fs");
const banned = ["node:sqlite", "sqlite", "@earendil-works/pi-durable", "@earendil-works/chord"];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (banned.some((name) => request === name || request.startsWith(name + "/"))) {
    throw new Error("SENTINEL: banned module loaded: " + request);
  }
  return originalLoad.call(this, request, parent, isMain);
};
for (const name of ["openSync", "open", "readFileSync", "writeFileSync", "createReadStream", "createWriteStream", "statSync"]) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    if (typeof path === "string" && path.endsWith("argos.sqlite")) {
      throw new Error("SENTINEL: argos.sqlite opened: " + path);
    }
    return original.call(this, path, ...args);
  };
}
`;

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { readonly require?: string } = {},
): Promise<ChildResult> {
  const nodeArgs = [];
  if (options.require !== undefined) nodeArgs.push("--require", options.require);
  const child = spawn(process.execPath, [...nodeArgs, distIndex, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Re-read output after exit: waitForExit attaches the listeners.
  return waitForExit(child, 20_000);
}

interface ServeChild {
  readonly child: ChildProcess;
  readonly port: number;
}

/** Spawn `argos serve --json` and wait for its `{port,...}` line (stdout is JSON only). */
function startServe(home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ServeChild> {
  const child = spawn(process.execPath, [distIndex, "serve", "--json", "--home", home], {
    env: { ...process.env, ARGOS_FAKE_PASEO: "1", ARGOS_PORT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`argos serve did not print its port within 20 s; stderr: ${stderr}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { port?: number };
          if (typeof parsed.port === "number") {
            clearTimeout(timer);
            resolve({ child, port: parsed.port });
          }
        } catch {
          // Not the JSON line yet; keep reading.
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`argos serve exited early (${code}); stderr: ${stderr}`));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child, 5_000);
  child.kill("SIGTERM");
  try {
    await exited;
  } catch {
    child.kill("SIGKILL");
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition still false after ${timeoutMs} ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

describe("argos run never opens the database", () => {
  it("serves a run while the client process is denied SQLite and the durable host", async () => {
    expect(existsSync(distIndex), "run `npm run build` before the CLI suite").toBe(true);

    const home = tempDir("argos-sentinel-home-");
    const repo = tempDir("argos-sentinel-repo-");
    const playbooks = join(repo, ".argos", "playbooks");
    mkdirSync(playbooks, { recursive: true });
    writeFileSync(
      join(playbooks, "quick.yaml"),
      [
        "title: Quick",
        "inputs:",
        "  issue: { type: string, required: true }",
        "steps:",
        "  - id: work",
        '    prompt: "Do {{ playbook.inputs.issue }}"',
        "    poll_ms: 20",
        "",
      ].join("\n"),
      "utf8",
    );
    const preload = join(home, "sentinel.cjs");
    writeFileSync(preload, PRELOAD, "utf8");

    const serve = await startServe(home);
    try {
      const clientEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ARGOS_HOME: home,
        ARGOS_PORT: String(serve.port),
      };
      const runResult = await run(
        ["run", "quick", "--input", "issue=42", "--cwd", repo, "--json"],
        clientEnv,
        { require: preload },
      );
      expect(runResult.code, `${runResult.stdout}\n${runResult.stderr}`).toBe(0);
      expect(runResult.stderr).not.toContain("SENTINEL");
      const started = JSON.parse(runResult.stdout) as { runId: string; taskId: string };
      expect(started.runId).not.toBe("");

      const token = readFileSync(join(home, "token"), "utf8").trim();
      let detail: RunDetail | undefined;
      await waitFor(async () => {
        const response = await fetch(
          `http://127.0.0.1:${serve.port}/runs/${started.runId}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!response.ok) return false;
        detail = (await response.json()) as RunDetail;
        return detail.status === "completed";
      });
      expect(detail?.playbookId).toBe("quick");
      expect(detail?.steps[0]?.status).toBe("completed");
      expect(existsSync(join(home, "argos.sqlite"))).toBe(true);
      // The server is still the live owner.
      expect(serve.child.exitCode).toBeNull();

      const doctorResult = await run(["doctor", "--json"], clientEnv);
      expect(doctorResult.code, doctorResult.stderr).toBe(0);
      const report = JSON.parse(doctorResult.stdout) as DoctorReport;
      expect(report.storage.path).toBe(join(home, "argos.sqlite"));
      expect(report.schemaVersion).toBe(1);
      expect(report.port).toBe(serve.port);
      expect(report.server.reachable).toBe(true);
      expect(report.paseo.reachable).toBe(true);
      expect(report.providers.length).toBeGreaterThan(0);
      expect(report.pendingGates).toEqual([]);

      // A second serve on the same home is refused before it can write anything.
      const second = await run(["serve", "--json", "--home", home], {
        ...process.env,
        ARGOS_FAKE_PASEO: "1",
        ARGOS_PORT: "0",
      });
      expect(second.code).not.toBe(0);
      expect(`${second.stdout}${second.stderr}`).toContain("storage_locked");
      expect(`${second.stdout}${second.stderr}`).toContain("serve.pid");
    } finally {
      await stop(serve.child);
    }
  }, 60_000);
});
