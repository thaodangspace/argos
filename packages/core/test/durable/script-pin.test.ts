/**
 * Phase 5 — FR3 script pinning, end to end against real executables.
 *
 * A run records `RunRecord.scripts` (absolute path + sha256) before its task or worktree exists;
 * `argos.script` re-hashes the file before every spawn and fails the step with `script_changed`
 * when it moved, changed, or vanished. `retryStep` re-pins and records `script_repinned`.
 *
 * The durable tests stay on the fake clock; only child-process work needs real time (`waitForReal`,
 * `driveIo`), exactly like `scripts.test.ts`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage, type TaskId, type TaskInspection } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { writeRunMirror } from "../../src/durable/mirror.js";
import { hashScript } from "../../src/durable/tasks/script-pin.js";
import type { RunRecord } from "../../src/engine/index.js";
import { isArgosError } from "../../src/errors.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { AfterIR, PlaybookIR, StepIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { installFixtureScript, makeTempRepo, writeScript } from "../support/git.js";
import { driveIo, makeTempHome, waitForReal } from "./support.js";

// ------------------------------------------------------------------ helpers

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** One `kind: script` step with no outputs, so the run record stays small. */
function scriptStep(id: string, script: string, extra: Partial<StepIR> = {}): StepIR {
  return step({ id, kind: "script", script: { run: script, env: [] }, outputs: {}, ...extra });
}

function scriptPlaybook(options: {
  readonly id: string;
  readonly script: string;
  readonly after?: readonly AfterIR[];
}): PlaybookIR {
  return playbook({
    id: options.id,
    steps: [scriptStep("run", options.script)],
    ...(options.after === undefined ? {} : { after: options.after }),
  });
}

/** The live `argos.script` task of one step (`inspect()` lists unfinished tasks only). */
async function scriptTaskOf(host: ArgosHost, stepId = "run"): Promise<TaskInspection | undefined> {
  const inspection = await host.inspect();
  return inspection.tasks.find(
    (candidate) =>
      candidate.record.kind === "argos.script" &&
      (candidate.record.input as { stepId?: string }).stepId === stepId,
  );
}

interface ScriptReceipt {
  readonly stepId?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly exitCode?: number;
  readonly runs?: number;
  readonly detail?: string;
}

async function scriptReceipt(host: ArgosHost, taskId: string): Promise<ScriptReceipt | undefined> {
  const record = await host.getTaskRecord(taskId);
  const state = record?.state as { status?: string; outcome?: { result?: ScriptReceipt } } | undefined;
  return state?.outcome?.result;
}

async function startedRun(host: ArgosHost, ir: PlaybookIR, cwd: string, id: string): Promise<string> {
  const { runId } = await host.startRun({ ir, inputs: {}, cwd, id });
  return runId;
}

async function recordOf(host: ArgosHost, runId: string): Promise<RunRecord> {
  const record = (await host.getRun(runId))?.record;
  if (record === undefined) throw new Error(`no mirrored record for ${runId}`);
  return record;
}

/** Wait for the run to reach `status`, advancing the fake clock and giving real child I/O time. */
async function waitForRunStatus(
  host: ArgosHost,
  clock: FakeClock,
  runId: string,
  status: string,
): Promise<RunRecord> {
  await driveIo(clock, async () => (await host.getRun(runId))?.record.status === status, {
    stepMs: 250,
    maxRounds: 200,
  });
  return recordOf(host, runId);
}

// ------------------------------------------------------------------ 1. pins

describe("script pinning: RunRecord.scripts (FR3.1)", () => {
  it("pins every main and after-step script before the run task exists", async () => {
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
      const build = writeScript(repo.repo, "build.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      const report = writeScript(repo.repo, "report.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      const ir = scriptPlaybook({
        id: "pinned",
        script: "build.mjs",
        // Manual: the after-step must be pinned without ever running here.
        after: [
          {
            id: "report",
            title: "Report",
            trigger: "manual",
            steps: [scriptStep("report-step", "report.mjs")],
          },
        ],
      });
      const runId = await startedRun(host, ir, repo.repo, "run-pin-main");
      const record = await recordOf(host, runId);

      expect(record.scripts).toEqual({
        "build.mjs": { path: build, sha256: sha256Of(build) },
        "report.mjs": { path: report, sha256: sha256Of(report) },
      });
      // `hashScript` is the same digest the record carries, so the check cannot drift.
      expect(record.scripts?.["build.mjs"]?.sha256).toBe(hashScript(build));

      await waitForRunStatus(host, clock, runId, "completed");
      const after = await recordOf(host, runId);
      expect(after.steps["run"]?.status).toBe("completed");
      expect(after.after["report"]?.status).toBe("pending");
      // The pin is part of the record, not a transient: it survives every commit of the run.
      expect(after.scripts).toEqual(record.scripts);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  // ---------------------------------------------------------------- 2. missing

  it("refuses a missing script with playbook_invalid, creating no task and no worktree", async () => {
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
      const ir = playbook({
        id: "missing-script",
        steps: [scriptStep("run", "absent.mjs")],
        // Isolation would create `<home>/worktrees/<runId>` — the pin refusal happens first.
        isolation: { mode: "worktree" },
      });
      const error = await host
        .startRun({ ir, inputs: {}, cwd: repo.repo, id: "run-pin-missing" })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(isArgosError(error) && error.code).toBe("playbook_invalid");
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("step run");
      expect(message).toContain("absent.mjs");
      expect(message).toContain(".argos/scripts");

      expect((await host.inspect()).tasks).toHaveLength(0);
      expect(await host.getRun("run-pin-missing")).toBeUndefined();
      expect(await host.getHistory("run-pin-missing")).toBeUndefined();
      expect(existsSync(join(home, "worktrees", "run-pin-missing"))).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  // ---------------------------------------------------------------- 3. non-executable

  it("refuses a script that is not executable with playbook_invalid", async () => {
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
      const path = join(repo.repo, ".argos", "scripts", "plain.mjs");
      mkdirSync(join(repo.repo, ".argos", "scripts"), { recursive: true });
      writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o644 });
      chmodSync(path, 0o644);

      const error = await host
        .startRun({
          ir: scriptPlaybook({ id: "not-executable", script: "plain.mjs" }),
          inputs: {},
          cwd: repo.repo,
          id: "run-pin-plain",
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(isArgosError(error) && error.code).toBe("playbook_invalid");
      expect(error instanceof Error ? error.message : "").toContain("not executable");
      expect(error instanceof Error ? error.message : "").toContain("step run");
      expect((await host.inspect()).tasks).toHaveLength(0);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

// ------------------------------------------------------------------ 4-7. script_changed

describe("script pinning: script_changed before every spawn (FR3.3)", () => {
  it("fails a script step as script_changed when an earlier step edited the script (no retry)", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const script = writeScript(
      repo.repo,
      "guarded.mjs",
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("ran.txt", "ran");',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    let edited = false;
    const executor = new FakeExecutor({
      complete: () => {
        // The agent rewrites the script mid-run: the pin already recorded the old bytes.
        if (!edited) {
          edited = true;
          writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");
        }
        return {};
      },
    });
    const host = await ArgosHost.open({ storage: new MemoryStorage(), home, clock, executor });
    try {
      const ir = playbook({
        id: "edited-mid-run",
        steps: [step({ id: "edit", pollMs: 25 }), scriptStep("run", "guarded.mjs", { needs: ["edit"] })],
      });
      const runId = await startedRun(host, ir, repo.repo, "run-pin-edited");
      const record = await waitForRunStatus(host, clock, runId, "failed");

      expect(record.errorCode).toBe("script_changed");
      expect(record.steps["run"]?.status).toBe("failed");
      expect(record.steps["run"]?.errorCode).toBe("script_changed");
      // One dispatch, one attempt, and the edited executable never ran.
      expect(record.steps["run"]?.attempts).toHaveLength(1);
      expect(existsSync(join(repo.repo, "ran.txt"))).toBe(false);
      expect(executor.creationsByStep()).toEqual({ edit: 1 });

      const history = await host.getHistory(runId);
      const dispatches = (history?.events ?? []).filter(
        (event) => event.type === "dispatch" && event.stepId === "run",
      );
      expect(dispatches).toHaveLength(1);
      expect((history?.events ?? []).some((event) => event.type === "script_repinned")).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("fails as script_changed when the script changes between two exit-75 runs", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const script = installFixtureScript(repo.repo, "exit-75-twice.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const runId = await startedRun(
        host,
        scriptPlaybook({ id: "edited-poll", script: "exit-75-twice.mjs" }),
        repo.repo,
        "run-pin-poll-edit",
      );
      // The first execution exits 75, so the task parks in a durable sleep.
      await driveIo(clock, async () => (await scriptTaskOf(host))?.state.kind === "sleeping");
      const taskId = (await scriptTaskOf(host))?.record.id as unknown as string;

      writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");
      const record = await waitForRunStatus(host, clock, runId, "failed");

      expect(record.errorCode).toBe("script_changed");
      expect(record.steps["run"]?.errorCode).toBe("script_changed");
      // Only the first (exit-75) execution happened; the edited script was never spawned.
      const receipt = await scriptReceipt(host, taskId);
      expect(receipt?.errorCode).toBe("script_changed");
      expect(receipt?.runs).toBe(1);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("fails as script_changed naming the missing file when the script is deleted", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const script = installFixtureScript(repo.repo, "exit-75-twice.mjs");
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new FakeExecutor(),
    });
    try {
      const runId = await startedRun(
        host,
        scriptPlaybook({ id: "deleted-poll", script: "exit-75-twice.mjs" }),
        repo.repo,
        "run-pin-poll-deleted",
      );
      await driveIo(clock, async () => (await scriptTaskOf(host))?.state.kind === "sleeping");
      const taskId = (await scriptTaskOf(host))?.record.id as unknown as string;
      expect(taskId).toBeDefined();

      rmSync(script);
      const record = await waitForRunStatus(host, clock, runId, "failed");

      expect(record.errorCode).toBe("script_changed");
      const receipt = await scriptReceipt(host, taskId);
      expect(receipt?.errorCode).toBe("script_changed");
      expect(receipt?.detail).toContain("missing");
      expect(receipt?.detail).toContain("exit-75-twice.mjs");
      // The check happens before the spawn, so the checkpoint never counted a second execution.
      expect(receipt?.runs).toBe(1);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("fails as script_changed after a close/reopen when the script was edited meanwhile", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const script = installFixtureScript(repo.repo, "exit-75-twice.mjs");
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const first = await ArgosHost.open({ home, clock, executor });
    let second: ArgosHost | undefined;
    try {
      const runId = await startedRun(
        first,
        scriptPlaybook({ id: "reopened-poll", script: "exit-75-twice.mjs" }),
        repo.repo,
        "run-pin-reopen",
      );
      await driveIo(clock, async () => (await scriptTaskOf(first))?.state.kind === "sleeping");
      await first.close();

      const pinnedSha = sha256Of(script);
      writeFileSync(script, "#!/usr/bin/env node\nprocess.exit(0);\n");
      expect(sha256Of(script)).not.toBe(pinnedSha);
      const clock2 = new FakeClock(clock.now());
      second = await ArgosHost.open({ home, clock: clock2, executor });
      // A1: the resumed task still carries the pinned script path and digest in its input — the
      // *old* digest, which is exactly what makes the edited file a `script_changed` failure.
      const resumed = await scriptTaskOf(second);
      const input = resumed?.record.input as { pin?: { sha256?: string } } | undefined;
      expect(input?.pin?.sha256).toBe(pinnedSha);

      const record = await waitForRunStatus(second, clock2, runId, "failed");
      expect(record.errorCode).toBe("script_changed");
      expect(record.steps["run"]?.errorCode).toBe("script_changed");
    } finally {
      await second?.close();
      if (second === undefined) await first.close();
      cleanup();
      repo.cleanup();
    }
  });
});

// ------------------------------------------------------------------ 8. retryStep re-pins

describe("script pinning: retryStep re-pins (FR3.4, D2)", () => {
  it("re-pins the reset closure, records script_repinned with both hashes, and completes", async () => {
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
      const script = writeScript(repo.repo, "check.mjs", "#!/usr/bin/env node\nprocess.exit(1);\n");
      const runId = await startedRun(
        host,
        scriptPlaybook({ id: "retried", script: "check.mjs" }),
        repo.repo,
        "run-pin-retry",
      );
      const failed = await waitForRunStatus(host, clock, runId, "failed");
      const before = failed.scripts?.["check.mjs"]?.sha256 ?? "";
      expect(before).toBe(sha256Of(script));

      // The operator fixes the script, then retries: that is the only way to run new code.
      writeScript(repo.repo, "check.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      const started = await host.retryStep(runId, "run");
      expect(started.runId).toBe(runId);

      const completed = await waitForRunStatus(host, clock, runId, "completed");
      const after = completed.scripts?.["check.mjs"]?.sha256 ?? "";
      expect(after).toBe(sha256Of(script));
      expect(after).not.toBe(before);
      expect(completed.steps["run"]?.status).toBe("completed");

      const history = await host.getHistory(runId);
      const repinned = (history?.events ?? []).filter((event) => event.type === "script_repinned");
      expect(repinned).toHaveLength(1);
      expect(repinned[0]?.stepId).toBe("run");
      expect(repinned[0]?.detail).toContain("check.mjs");
      expect(repinned[0]?.detail).toContain(before);
      expect(repinned[0]?.detail).toContain(after);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses a retry when a script in the reset closure is gone, before any task exists", async () => {
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
      const script = writeScript(repo.repo, "gone.mjs", "#!/usr/bin/env node\nprocess.exit(1);\n");
      const runId = await startedRun(
        host,
        scriptPlaybook({ id: "retry-missing", script: "gone.mjs" }),
        repo.repo,
        "run-pin-retry-missing",
      );
      await waitForRunStatus(host, clock, runId, "failed");

      rmSync(script);
      const tasksBefore = (await host.inspect()).tasks.length;
      const error = await host.retryStep(runId, "run").then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isArgosError(error) && error.code).toBe("playbook_invalid");
      expect(error instanceof Error ? error.message : "").toContain("step run");
      expect((await host.inspect()).tasks).toHaveLength(tasksBefore);
      expect((await recordOf(host, runId)).status).toBe("failed");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

// ------------------------------------------------------------------ 9-10. after-tasks, old records

describe("script pinning: after-tasks and pre-pinning records (FR3.5, FR3.6)", () => {
  it("gives an after-task child the parent's pinned scripts", async () => {
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
      writeScript(repo.repo, "parent.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      writeScript(repo.repo, "report.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      const ir = scriptPlaybook({
        id: "after-pinned",
        script: "parent.mjs",
        after: [
          {
            id: "report",
            title: "Report",
            trigger: "auto",
            steps: [scriptStep("report-step", "report.mjs")],
          },
        ],
      });
      const runId = await startedRun(host, ir, repo.repo, "run-pin-after");

      let childId: string | undefined;
      await waitForReal(async () => {
        const child = (await host.listRuns()).find(
          (doc) => doc.record.playbookId === "after-pinned/report" && doc.record.status === "completed",
        );
        childId = child?.record.id;
        return childId !== undefined;
      });

      const parent = await recordOf(host, runId);
      expect(parent.after["report"]?.status).toBe("completed");
      const child = childId === undefined ? undefined : await recordOf(host, childId);
      expect(child?.id).not.toBe(runId);
      expect(child?.scripts).toEqual(parent.scripts);
      expect(Object.keys(child?.scripts ?? {}).sort()).toEqual(["parent.mjs", "report.mjs"]);
      expect(child?.steps["report-step"]?.status).toBe("completed");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("uses resolve-at-prepare when the record has no scripts (FR3.6)", async () => {
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
      const script = writeScript(repo.repo, "legacy.mjs", "#!/usr/bin/env node\nprocess.exit(1);\n");
      const runId = await startedRun(
        host,
        scriptPlaybook({ id: "legacy-record", script: "legacy.mjs" }),
        repo.repo,
        "run-pin-legacy",
      );
      await waitForRunStatus(host, clock, runId, "failed");
      const doc = await host.getRun(runId);
      expect(doc?.record.scripts).toEqual({ "legacy.mjs": expect.objectContaining({}) });

      // Simulate a mirror written before pinning existed: drop the field. `retryStep` reads the
      // mirror, so the new task starts from a record without pins and must resolve at `prepare`.
      const stripped = JSON.parse(JSON.stringify(doc?.record)) as Record<string, unknown>;
      delete stripped["scripts"];
      const taskId = Number(doc?.taskId);
      await host.harness.commit(async (tx) => {
        await writeRunMirror(tx, taskId as TaskId, stripped as unknown as RunRecord);
      }, host.context);
      expect((await recordOf(host, runId)).scripts).toBeUndefined();

      // The fix is visible without a re-pin: an unpinned record resolves the file it finds.
      writeScript(repo.repo, "legacy.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n");
      await host.retryStep(runId, "run");
      const completed = await waitForRunStatus(host, clock, runId, "completed");

      expect(completed.steps["run"]?.status).toBe("completed");
      expect(completed.scripts).toBeUndefined();
      const history = await host.getHistory(runId);
      expect((history?.events ?? []).some((event) => event.type === "script_repinned")).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});
