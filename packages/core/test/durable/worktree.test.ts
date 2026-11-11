/**
 * Phase 7 worktree isolation (FR23, D9) — the run-level wiring.
 *
 * The unit suite (`test/git/worktree.test.ts`) covers git itself; this one proves the host: the
 * record carries `{path, branch, baseSha}`, every agent gets the worktree as `cwd`, a dirty base
 * refuses the run before any task exists, and `isolation.mode: none` keeps the given `cwd`.
 */

import { existsSync, writeFileSync } from "node:fs";
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
