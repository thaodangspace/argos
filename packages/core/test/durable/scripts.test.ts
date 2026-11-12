/**
 * Phase 7 script steps (FR22, D10) — `argos.script` end to end against real executables.
 *
 * These tests spawn real processes (from `test/fixtures/scripts/`), so they wait on real time
 * between fake-clock advances; nothing here touches the network or a Paseo daemon.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage, type TaskInspection } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { resolveScriptPath, type ScriptCheckpoint } from "../../src/durable/tasks/script.js";
import { isArgosError } from "../../src/errors.js";
import type { RunRecord } from "../../src/engine/index.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { installFixtureScript, makeTempRepo, writeScript } from "../support/git.js";
import { driveIo, makeTempHome, waitForReal } from "./support.js";

/** The live `argos.script` task of one step (`inspect()` lists unfinished tasks only). */
async function scriptTaskOf(host: ArgosHost, stepId = "run"): Promise<TaskInspection | undefined> {
  const inspection = await host.inspect();
  return inspection.tasks.find(
    (candidate) =>
      candidate.record.kind === "argos.script" &&
      (candidate.record.input as { stepId?: string }).stepId === stepId,
  );
}

/** The committed checkpoint of a live task (a terminal task keeps none). */
function checkpointOf(task: TaskInspection | undefined): ScriptCheckpoint | undefined {
  const state = task?.record.state as { checkpoint?: ScriptCheckpoint } | undefined;
  return state?.checkpoint;
}

/**
 * The task id of the script child. A terminal task carries no checkpoint, so the id has to be
 * captured while it is still live and its receipt read afterwards with `getTaskRecord`.
 */
async function scriptTaskId(host: ArgosHost, stepId = "run"): Promise<string> {
  let id: string | undefined;
  await waitForReal(async () => {
    id = (await scriptTaskOf(host, stepId))?.record.id as unknown as string | undefined;
    return id !== undefined;
  });
  return id as string;
}

interface ScriptReceipt {
  readonly stepId?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly exitCode?: number;
  readonly runs?: number;
  readonly signal?: string;
  readonly detail?: string;
  readonly outputs?: Readonly<Record<string, string | number | boolean>>;
}

/** The terminal `argos.script` result (the task's receipt, which survives the checkpoint). */
async function scriptReceipt(host: ArgosHost, taskId: string): Promise<ScriptReceipt | undefined> {
  const record = await host.getTaskRecord(taskId);
  const state = record?.state as { status?: string; outcome?: { result?: ScriptReceipt } } | undefined;
  return state?.outcome?.result;
}

function scriptPlaybook(options: {
  readonly script: string;
  readonly env?: readonly string[];
  readonly outputs?: PlaybookIR["steps"][number]["outputs"];
  readonly pollMs?: number;
  readonly timeout?: number;
}): PlaybookIR {
  return playbook({
    id: "scripted",
    steps: [
      step({
        id: "run",
        kind: "script",
        needs: [],
        script: { run: options.script, env: [...(options.env ?? [])] },
        pollMs: options.pollMs ?? 250,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        outputs: options.outputs ?? {},
      }),
    ],
  });
}

function codeOf(record: RunRecord | undefined): string | undefined {
  return record?.errorCode ?? undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("script steps: exit 75 protocol (FR22)", () => {
  it("parks in sleeping on exit 75, re-runs, and completes on exit 0 with outputs", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "exit-75-twice.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId } = await host.startRun({
        ir: scriptPlaybook({
          script: "exit-75-twice.mjs",
          outputs: {
            stdout: { type: "string" },
            stderr: { type: "string" },
            exitCode: { type: "number" },
            runs: { type: "number" },
          },
        }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-poll",
      });

      // First execution: the script exits 75, so the task must be parked in a durable sleep.
      await driveIo(clock, async () => (await scriptTaskOf(host))?.state.kind === "sleeping");
      const taskId = await scriptTaskId(host);
      const sleeping = await scriptTaskOf(host);
      expect(sleeping?.state.kind).toBe("sleeping");
      if (sleeping?.state.kind === "sleeping") {
        expect(sleeping.state.until).toBeGreaterThan(clock.now());
        expect(sleeping.state.until).toBeLessThanOrEqual(clock.now() + 250);
      }
      expect(checkpointOf(sleeping)?.runs).toBe(1);
      expect(checkpointOf(sleeping)?.exitCode).toBe(75);
      expect((await host.getRun(runId))?.record.status).toBe("running");

      // Wake, run again (75), wake, run again (0).
      await driveIo(clock, async () => (await host.getRun(runId))?.record.status === "completed", {
        maxRounds: 200,
      });

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["run"]?.status).toBe("completed");
      expect(record?.steps["run"]?.outcome).toBe("success");
      expect(record?.steps["run"]?.outputs["stdout"]).toBe("done\n");
      expect(record?.steps["run"]?.outputs["exitCode"]).toBe(0);
      expect(record?.steps["run"]?.outputs["runs"]).toBe(3);
      // One `argos.script` child for the step: the exit-75 loop lives inside the child task.
      const receipt = await scriptReceipt(host, taskId);
      expect(receipt?.runs).toBe(3);
      expect(receipt?.exitCode).toBe(0);
      expect(receipt?.errorCode).toBeUndefined();

      // Three attempts of one dispatch: the engine saw one run-level dispatch.
      expect(record?.steps["run"]?.attempts).toHaveLength(1);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("fails the step with step_failed on a non-zero exit and keeps the exit code and stderr tail", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "fail.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId } = await host.startRun({
        ir: scriptPlaybook({ script: "fail.mjs", outputs: { stderr: { type: "string" } } }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-fail",
      });
      const taskId = await scriptTaskId(host);
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "failed");

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("step_failed");
      expect(record?.steps["run"]?.status).toBe("failed");
      expect(record?.steps["run"]?.errorCode).toBe("step_failed");

      // The step result is a *completed* task carrying an error code (task failure is reserved).
      const receipt = await scriptReceipt(host, taskId);
      expect(receipt?.errorCode).toBe("step_failed");
      expect(receipt?.exitCode).toBe(3);
      expect(receipt?.runs).toBe(1);
      expect(receipt?.detail).toContain("boom: fixture failure");
      expect(receipt?.detail).toContain("exited 3");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("bounds a script that never exits with script_timeout and kills the whole process group", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "sleep-forever.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId } = await host.startRun({
        ir: scriptPlaybook({ script: "sleep-forever.mjs", timeout: 400 }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-timeout",
      });

      const pidFile = join(repo.repo, "script.pids");
      await waitForReal(() => existsSync(pidFile));
      const taskId = await scriptTaskId(host);
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "failed");

      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("failed");
      expect(codeOf(record)).toBe("script_timeout");
      expect(record?.steps["run"]?.errorCode).toBe("script_timeout");

      const receipt = await scriptReceipt(host, taskId);
      expect(receipt?.errorCode).toBe("script_timeout");
      expect(receipt?.signal).toBe("SIGKILL");
      expect(receipt?.detail).toContain("timeout");

      // The script and its own child are both gone: the step timeout kills the process group.
      const pids = readFileSync(pidFile, "utf8")
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      expect(pids.length).toBe(2);
      await waitForReal(() => pids.every((pid) => !processIsAlive(pid)), { timeoutMs: 3_000 });
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("kills the child when the task is aborted", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "sleep-forever.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const { runId } = await host.startRun({
        ir: scriptPlaybook({ script: "sleep-forever.mjs", timeout: 60_000 }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-abort",
      });

      const pidFile = join(repo.repo, "script.pids");
      await waitForReal(() => existsSync(pidFile));
      const task = await scriptTaskOf(host);
      expect(task?.state.kind).toBe("running");

      const pids = readFileSync(pidFile, "utf8")
        .split("\n")
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      expect(pids.every((pid) => processIsAlive(pid))).toBe(true);

      await host.harness.abortTask(task?.record.id as never, host.context);

      // The abort signal reaches the phase, which kills the group before the task settles.
      await waitForReal(() => pids.every((pid) => !processIsAlive(pid)), { timeoutMs: 5_000 });
      await waitForReal(async () => {
        const status = (await host.getRun(runId))?.record.status;
        return status === "failed" || status === "cancelled";
      });
      expect((await host.getRun(runId))?.record.steps["run"]?.status).toBe("failed");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("script steps: read-only guard (D8)", () => {
  it("fails a read-only script that writes with readonly_violation, even on exit 0", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "write-file.mjs");
    // A script an isolated run uses has to exist on the base commit, so the worktree has it too.
    repo.git(["add", ".argos"]);
    repo.git(["commit", "--quiet", "-m", "add the fixture script"]);
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const ir = playbook({
        id: "scripted-readonly",
        steps: [
          step({
            id: "run",
            kind: "script",
            script: { run: "write-file.mjs", env: [] },
            role: {
              id: "reviewer",
              title: "Reviewer",
              readonly: true,
              instructions: "Read only.",
              fallbacks: [],
            },
          }),
        ],
        isolation: { mode: "worktree" },
      });
      const { runId } = await host.startRun({
        ir,
        inputs: {},
        cwd: repo.repo,
        id: "run-script-readonly",
      });
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "failed");

      const record = (await host.getRun(runId))?.record;
      expect(record?.errorCode).toBe("readonly_violation");
      expect(record?.steps["run"]?.errorCode).toBe("readonly_violation");
      // The script really ran (exit 0) and the worktree kept its file for inspection.
      const worktree = record?.worktree?.path ?? "";
      expect(existsSync(join(worktree, "script-note.txt"))).toBe(true);
      expect(existsSync(join(repo.repo, "script-note.txt"))).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("script steps: env filter (D10)", () => {
  const KEYS = ["MY_API_KEY", "PATH", "HOME", "LANG", "TMPDIR"] as const;

  async function envKeys(host: ArgosHost, runId: string): Promise<string[]> {
    const record = (await host.getRun(runId))?.record;
    const stdout = record?.steps["run"]?.outputs["stdout"];
    expect(typeof stdout).toBe("string");
    return JSON.parse(String(stdout)) as string[];
  }

  it("drops MY_API_KEY from the child environment but keeps PATH, HOME, LANG, and TMPDIR", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "env-keys.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    const saved = KEYS.map((name) => [name, process.env[name]] as const);
    const baseline = {
      HOME: process.env["HOME"] ?? "/tmp",
      LANG: "en_US.UTF-8",
      TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    };
    try {
      Object.assign(process.env, baseline, { MY_API_KEY: "sk-live-should-not-leak" });
      const { runId } = await host.startRun({
        ir: scriptPlaybook({
          script: "env-keys.mjs",
          outputs: { stdout: { type: "string" } },
        }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-env-hidden",
      });
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "completed");
      const keys = await envKeys(host, runId);
      expect(keys).not.toContain("MY_API_KEY");
      for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
        expect(keys, name).toContain(name);
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("passes a secret through when the step declares it in env", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "env-keys.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    const saved = process.env["MY_API_KEY"];
    try {
      process.env["MY_API_KEY"] = "sk-declared-allowed";
      const { runId } = await host.startRun({
        ir: scriptPlaybook({
          script: "env-keys.mjs",
          env: ["MY_API_KEY"],
          outputs: { stdout: { type: "string" } },
        }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-env-declared",
      });
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "completed");
      expect(await envKeys(host, runId)).toContain("MY_API_KEY");
    } finally {
      if (saved === undefined) delete process.env["MY_API_KEY"];
      else process.env["MY_API_KEY"] = saved;
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  /** Run `env-keys.mjs` with `overrides` in the parent env and return the child's variable names. */
  async function runEnvKeys(
    id: string,
    overrides: Readonly<Record<string, string>>,
    grants: readonly string[] = [],
  ): Promise<string[]> {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    installFixtureScript(repo.repo, "env-keys.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    const saved = Object.keys(overrides).map((name) => [name, process.env[name]] as const);
    try {
      Object.assign(process.env, overrides);
      const { runId } = await host.startRun({
        ir: scriptPlaybook({
          script: "env-keys.mjs",
          env: grants,
          outputs: { stdout: { type: "string" } },
        }),
        inputs: {},
        cwd: repo.repo,
        id,
      });
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "completed");
      return await envKeys(host, runId);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await host.close();
      cleanup();
      repo.cleanup();
    }
  }

  it("omits a name the playbook never grants, even a harmless one (FR2.1)", async () => {
    const keys = await runEnvKeys("run-script-env-ungranted", {
      CARGO_HOME: "/home/tester/.cargo",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    for (const name of ["CARGO_HOME", "SSH_AUTH_SOCK", "NODE_OPTIONS"]) {
      expect(keys, name).not.toContain(name);
    }
    expect(keys).toContain("PATH");
  });

  it("never passes a deny-listed name, even when the step grants it (FR2.4)", async () => {
    const keys = await runEnvKeys(
      "run-script-env-denied",
      { ARGOS_PASEO_PASSWORD: "daemon-password", ARGOS_PORT: "7676" },
      ["ARGOS_PASEO_PASSWORD", "ARGOS_PORT"],
    );
    expect(keys).not.toContain("ARGOS_PASEO_PASSWORD");
    expect(keys).not.toContain("ARGOS_PORT");
    expect(keys).toContain("PATH");
  });
});

describe("resolveScriptPath (FR22)", () => {
  it("finds an executable in .argos/scripts, then in the paseo-compatible directory", async () => {
    const repo = makeTempRepo();
    try {
      const argos = writeScript(repo.repo, "tool.mjs", "#!/usr/bin/env node\n");
      expect(resolveScriptPath(repo.repo, "tool.mjs")).toBe(argos);

      const paseo = join(repo.repo, ".paseo/plugins/playbooks/scripts/legacy.mjs");
      mkdirSync(join(repo.repo, ".paseo/plugins/playbooks/scripts"), { recursive: true });
      writeFileSync(paseo, "#!/usr/bin/env node\n", { mode: 0o755 });
      chmodSync(paseo, 0o755);
      expect(resolveScriptPath(repo.repo, "legacy.mjs")).toBe(paseo);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects absolute paths, traversal, and a file that is not executable", async () => {
    const repo = makeTempRepo();
    try {
      for (const name of ["/bin/sh", "../escape.sh", "sub/tool.mjs", ".", ".."]) {
        expect(() => resolveScriptPath(repo.repo, name), name).toThrow(/script/);
      }
      mkdirSync(join(repo.repo, ".argos", "scripts"), { recursive: true });
      writeFileSync(join(repo.repo, ".argos", "scripts", "plain.mjs"), "#!/usr/bin/env node\n", {
        mode: 0o644,
      });
      chmodSync(join(repo.repo, ".argos", "scripts", "plain.mjs"), 0o644);
      expect(() => resolveScriptPath(repo.repo, "plain.mjs")).toThrow(/not executable/);
      expect(() => resolveScriptPath(repo.repo, "absent.mjs")).toThrow(/\.argos\/scripts\/absent\.mjs/);
    } finally {
      repo.cleanup();
    }
  });

  it("falls back to <home>/scripts, and the repository executable still wins", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const global = join(home, "scripts", "global.mjs");
      mkdirSync(join(home, "scripts"), { recursive: true });
      writeFileSync(global, "#!/usr/bin/env node\n", { mode: 0o755 });
      chmodSync(global, 0o755);

      expect(() => resolveScriptPath(repo.repo, "global.mjs")).toThrow(/not found/);
      expect(resolveScriptPath(repo.repo, "global.mjs", home)).toBe(global);

      const local = writeScript(repo.repo, "global.mjs", "#!/usr/bin/env node\n");
      expect(resolveScriptPath(repo.repo, "global.mjs", home)).toBe(local);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("keeps rejecting absolute and traversal names when a home is supplied", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      mkdirSync(join(home, "scripts"), { recursive: true });
      for (const name of ["/bin/sh", "../escape.sh", "sub/tool.mjs", "..", "."]) {
        expect(() => resolveScriptPath(repo.repo, name, home), name).toThrow(/script/);
      }
      expect(() => resolveScriptPath(repo.repo, "absent.mjs", home)).toThrow(
        join(home, "scripts", "absent.mjs"),
      );
    } finally {
      cleanup();
      repo.cleanup();
    }
  });
});

describe("script steps: resolution", () => {
  it("refuses the run with playbook_invalid when the script does not exist (FR3.2)", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      // Pinning happens before any task exists, so the refusal is synchronous (a rejected
      // `startRun`) and names the step and every path that was tried.
      const error = await host
        .startRun({
          ir: scriptPlaybook({ script: "missing.mjs" }),
          inputs: {},
          cwd: repo.repo,
          id: "run-script-missing",
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(isArgosError(error) && error.code).toBe("playbook_invalid");
      expect(error instanceof Error ? error.message : "").toContain("step run");
      expect(error instanceof Error ? error.message : "").toContain("missing.mjs");
      // Nothing exists to run: no run task, no mirror, no history.
      expect((await host.inspect()).tasks).toHaveLength(0);
      expect(await host.getRun("run-script-missing")).toBeUndefined();
      expect(await host.getHistory("run-script-missing")).toBeUndefined();
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("script steps: global scripts in $ARGOS_HOME", () => {
  it("runs a script that exists only under <home>/scripts, in the run cwd", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      mkdirSync(join(home, "scripts"), { recursive: true });
      const script = join(home, "scripts", "global.mjs");
      writeFileSync(
        script,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(`cwd=${process.cwd()}\\n`);",
          "process.exit(0);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      chmodSync(script, 0o755);

      const { runId } = await host.startRun({
        ir: scriptPlaybook({
          script: "global.mjs",
          outputs: { stdout: { type: "string" }, exitCode: { type: "number" } },
        }),
        inputs: {},
        cwd: repo.repo,
        id: "run-script-global",
      });
      await waitForReal(async () => (await host.getRun(runId))?.record.status === "completed");
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      const stdout = String(record?.steps["run"]?.outputs["stdout"] ?? "");
      // The executable comes from the home; it still executes in the project, never in the home.
      expect(stdout).toContain(`cwd=${realpathSync(repo.repo)}`);
      expect(stdout).not.toContain(`cwd=${realpathSync(home)}`);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});
