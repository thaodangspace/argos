/**
 * Phase 7 worktree isolation (FR23, D9) — the run-level wiring.
 *
 * The unit suite (`test/git/worktree.test.ts`) covers git itself; this one proves the host: the
 * record carries `{path, branch, baseSha}`, every agent gets the worktree as `cwd`, a dirty base
 * refuses the run before any task exists, and `isolation.mode: none` keeps the given `cwd`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { isArgosError } from "../../src/errors.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { IsolationIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo } from "../support/git.js";
import { drive, makeTempHome } from "./support.js";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

function codeOf(error: unknown): string | undefined {
  return isArgosError(error) ? error.code : undefined;
}

function isolatedPlaybook(isolation: IsolationIR) {
  return playbook({ id: "isolated", steps: [step({ id: "work" })], isolation });
}

describe("worktree isolation: creation", () => {
  it("creates <home>/worktrees/<runId> on argos/<runId> and launches agents in it", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-worktree-1";
      const started = await host.startRun({
        ir: isolatedPlaybook({ mode: "worktree" }),
        inputs: {},
        cwd: repo.repo,
        id: runId,
      });

      const record = (await host.getRun(started.runId))?.record;
      expect(record?.worktree).toEqual({
        path: join(home, "worktrees", runId),
        branch: `argos/${runId}`,
        baseSha: repo.headSha,
      });
      expect(existsSync(join(home, "worktrees", runId, "README.md"))).toBe(true);
      expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"], join(home, "worktrees", runId))).toBe(
        `argos/${runId}`,
      );

      await drive(clock, () => executor.creationsByStep()["work"] === 1, { stepMs: 500 });
      const agent = executor.agentForStep("work");
      expect(agent.cwd).toBe(join(home, "worktrees", runId));
      expect(agent.cwd).toBe(record?.worktree?.path);

      await drive(clock, async () => (await host.getRun(started.runId))?.record.status === "completed");
      expect((await host.getRun(started.runId))?.record.status).toBe("completed");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("lets `startRun.isolation` override the frozen IR (Phase 8's --isolation)", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      // IR says none, the caller asks for a worktree.
      const isolated = await host.startRun({
        ir: isolatedPlaybook({ mode: "none" }),
        inputs: {},
        cwd: repo.repo,
        id: "run-override-on",
        isolation: { mode: "worktree" },
      });
      expect((await host.getRun(isolated.runId))?.record.worktree?.path).toBe(
        join(home, "worktrees", "run-override-on"),
      );

      // IR says worktree, the caller asks for none: the run works in the given cwd and no git is
      // needed at all.
      const plain = makeTempHome();
      try {
        const inPlace = await host.startRun({
          ir: isolatedPlaybook({ mode: "worktree" }),
          inputs: {},
          cwd: plain.home,
          id: "run-override-off",
          isolation: { mode: "none" },
        });
        expect((await host.getRun(inPlace.runId))?.record.worktree).toBeUndefined();
        // The first run already created one agent for `work`; this one is the second.
        await drive(clock, () => executor.creations.length === 2, { stepMs: 500 });
        expect(executor.latestAgentForStep("work")?.cwd).toBe(plain.home);
      } finally {
        plain.cleanup();
      }
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("worktree isolation: refusals", () => {
  it("refuses a dirty base with worktree_base_dirty before any task or agent exists", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      writeFileSync(join(repo.repo, "uncommitted.txt"), "not in the commit\n");
      const error = await errorOf(
        host.startRun({
          ir: isolatedPlaybook({ mode: "worktree" }),
          inputs: {},
          cwd: repo.repo,
          id: "run-dirty",
        }),
      );
      expect(codeOf(error)).toBe("worktree_base_dirty");

      // Zero agents, zero run tasks, zero worktrees.
      expect(executor.creations).toEqual([]);
      expect(executor.launchCalls).toEqual([]);
      const inspection = await host.inspect();
      expect(inspection.tasks.filter((task) => task.record.kind === "argos.run")).toEqual([]);
      expect(existsSync(join(home, "worktrees", "run-dirty"))).toBe(false);
      expect((await host.getRun("run-dirty"))).toBeUndefined();
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses a base ref that does not exist with worktree_failed", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const error = await errorOf(
        host.startRun({
          ir: isolatedPlaybook({ mode: "worktree", base: "no-such-base" }),
          inputs: {},
          cwd: repo.repo,
          id: "run-bad-base",
        }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("origin/no-such-base");
      expect(executor.creations).toEqual([]);
      expect(existsSync(join(home, "worktrees", "run-bad-base"))).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

/**
 * FR4 worktree cleanup — `argos worktree rm` / `argos worktree gc` at the host level.
 *
 * The git mechanics live in `test/git/worktree.test.ts`; this suite proves the host rules: the
 * record is the only source of a path, a live run is `run_active`, a run without a worktree is a
 * `removed: false` receipt, gc selects by the mirrored `updatedAt` and never touches an orphan, and
 * a retry either re-attaches the branch (FR4.7) or refuses before any task exists.
 */

function isolatedStepPlaybook(id: string, stepId: string) {
  return playbook({
    id,
    steps: [step({ id: stepId })],
    isolation: { mode: "worktree" },
  });
}

/** One step that never finishes, with a deadline far past any test advance. */
function holdPlaybook(id: string) {
  return playbook({
    id,
    steps: [step({ id: "hold", pollMs: 60_000, timeout: 24 * 60 * 60_000 })],
    isolation: { mode: "worktree" },
  });
}

describe("worktree cleanup: remove (FR4.1–FR4.4)", () => {
  it("refuses a live run with run_active and an unknown one with run_unknown", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-rm-active";
      await host.startRun({
        ir: isolatedStepPlaybook("isolated-hold", "hold"),
        inputs: {},
        cwd: repo.repo,
        id: runId,
      });
      await drive(clock, () => existsSync(join(home, "worktrees", runId)), { stepMs: 500 });

      const active = await errorOf(host.removeWorktree(runId));
      expect(codeOf(active)).toBe("run_active");
      expect((active as Error).message).toContain("running");
      // Nothing was touched: the worktree of a live run is still there.
      expect(existsSync(join(home, "worktrees", runId))).toBe(true);

      const unknown = await errorOf(host.removeWorktree("run-nope"));
      expect(codeOf(unknown)).toBe("run_unknown");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("reports removed:false for a run that never had a worktree", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-no-worktree";
      await host.startRun({
        ir: isolatedPlaybook({ mode: "none" }),
        inputs: {},
        cwd: home,
        id: runId,
      });
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");

      expect(await host.removeWorktree(runId)).toEqual({
        runId,
        path: "",
        removed: false,
        branchDeleted: false,
      });
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("refuses a record whose worktree is not the one Argos creates", async () => {
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-bogus-worktree";
      await host.startRun({
        ir: isolatedPlaybook({ mode: "none" }),
        inputs: {},
        cwd: home,
        id: runId,
        // A record can name anything; the guard only accepts <home>/worktrees/<runId>.
        worktree: { path: join(home, "elsewhere"), branch: "argos/somewhere-else", baseSha: "0" },
      });
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");

      const error = await errorOf(host.removeWorktree(runId, { force: true }));
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("only cleans up worktrees it created");
    } finally {
      await host.close();
      cleanup();
    }
  });
});

describe("worktree cleanup: gc (FR4.5)", () => {
  it("selects terminal runs by olderThan, honours dryRun, skips active runs, reports orphans", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({
      complete: (agent) => (agent.stepId === "hold" ? undefined : {}),
    });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    const hour = 60 * 60_000;
    try {
      const start = async (id: string, ir: ReturnType<typeof playbook>): Promise<string> => {
        const started = await host.startRun({ ir, inputs: {}, cwd: repo.repo, id });
        return started.runId;
      };
      const finished = async (runId: string): Promise<void> => {
        await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      };

      const live = await start("gc-live", holdPlaybook("hold-run"));
      const old = await start("gc-old", isolatedStepPlaybook("isolated-old", "work"));
      await finished(old);
      await clock.advance(30 * 60_000);
      const fresh = await start("gc-fresh", isolatedStepPlaybook("isolated-fresh", "work"));
      await finished(fresh);
      // gc-old is 70+ min old, gc-fresh ~40 min, gc-live has been running for 70 min.
      await clock.advance(40 * 60_000);

      const orphan = join(home, "worktrees", "orphan-dir");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "leftover.txt"), "nobody claims this\n");

      const dry = await host.gcWorktrees({ olderThanMs: hour, dryRun: true });
      expect(dry.removed.map((entry) => entry.runId)).toEqual([old]);
      expect(dry.skipped).toContainEqual({ runId: live, reason: "active" });
      expect(dry.skipped.some((entry) => entry.runId === fresh)).toBe(false);
      expect(dry.orphans).toContain(orphan);
      // dryRun deletes nothing: both checkouts and the orphan are still on disk.
      expect(existsSync(join(home, "worktrees", old))).toBe(true);
      expect(existsSync(join(home, "worktrees", fresh))).toBe(true);
      expect(existsSync(join(orphan, "leftover.txt"))).toBe(true);

      const swept = await host.gcWorktrees({ olderThanMs: hour });
      expect(swept.removed).toEqual([
        { runId: old, path: join(home, "worktrees", old), branchDeleted: false },
      ]);
      expect(swept.skipped).toContainEqual({ runId: live, reason: "active" });
      expect(swept.orphans).toContain(orphan);
      expect(existsSync(join(home, "worktrees", old))).toBe(false);
      // The branch survives the default sweep, so the run could still be retried.
      expect(repo.git(["rev-parse", "--verify", `refs/heads/argos/${old}`])).not.toBe("");
      // The fresh run and the orphan are untouched.
      expect(existsSync(join(home, "worktrees", fresh))).toBe(true);
      expect(existsSync(join(orphan, "leftover.txt"))).toBe(true);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("worktree cleanup: retry after removal (FR4.7)", () => {
  it("re-attaches the branch and completes the retried step", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-retry-reattach";
      await host.startRun({
        ir: isolatedStepPlaybook("isolated-retry", "work"),
        inputs: {},
        cwd: repo.repo,
        id: runId,
      });
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");

      const removed = await host.removeWorktree(runId);
      expect(removed.removed).toBe(true);
      expect(existsSync(join(home, "worktrees", runId))).toBe(false);
      // The default keeps `argos/<runId>`: that is what a retry attaches again.
      expect(repo.git(["rev-parse", "--verify", `refs/heads/argos/${runId}`])).toBe(repo.headSha);

      const retried = await host.retryStep(runId, "work");
      expect(retried.runId).toBe(runId);
      expect(existsSync(join(home, "worktrees", runId, "README.md"))).toBe(true);
      expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"], join(home, "worktrees", runId))).toBe(
        `argos/${runId}`,
      );

      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["work"]?.attempts).toHaveLength(2);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses the retry when the branch is gone, before any task or agent exists", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const runId = "run-retry-nobranch";
      await host.startRun({
        ir: isolatedStepPlaybook("isolated-nobranch", "work"),
        inputs: {},
        cwd: repo.repo,
        id: runId,
      });
      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");

      const removed = await host.removeWorktree(runId, { deleteBranch: true });
      expect(removed).toEqual({
        runId,
        path: join(home, "worktrees", runId),
        removed: true,
        branchDeleted: true,
      });
      const runsBefore = (await host.inspect()).tasks.filter(
        (task) => task.record.kind === "argos.run",
      ).length;
      const creationsBefore = executor.creations.length;

      const error = await errorOf(host.retryStep(runId, "work"));
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain(`argos/${runId}`);

      // No retry task, no relaunch, and the run record still reports the old terminal state.
      const runsAfter = (await host.inspect()).tasks.filter(
        (task) => task.record.kind === "argos.run",
      ).length;
      expect(runsAfter).toBe(runsBefore);
      expect(executor.creations.length).toBe(creationsBefore);
      expect((await host.getRun(runId))?.record.status).toBe("completed");
      expect(existsSync(join(home, "worktrees", runId))).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});

describe("worktree isolation: the worktree is the run's world", () => {
  it("keeps the source checkout clean while the agent works in the worktree", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor,
    });
    try {
      const { runId } = await host.startRun({
        ir: isolatedPlaybook({ mode: "worktree" }),
        inputs: {},
        cwd: repo.repo,
        id: "run-isolated-writes",
      });
      await drive(clock, () => executor.creationsByStep()["work"] === 1, { stepMs: 500 });
      const agent = executor.agentForStep("work");
      writeFileSync(join(agent.cwd, "agent-output.txt"), "written by the step\n");

      await drive(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      expect(existsSync(join(home, "worktrees", "run-isolated-writes", "agent-output.txt"))).toBe(
        true,
      );
      expect(existsSync(join(repo.repo, "agent-output.txt"))).toBe(false);
      // The source checkout stays clean: the worktree owns every change of the run.
      expect(repo.git(["status", "--porcelain=v1"])).toBe("");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});
