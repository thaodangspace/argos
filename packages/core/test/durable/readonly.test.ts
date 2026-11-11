/**
 * Phase 7 read-only guard (FR23, D8) — snapshot before launch, compare after the turn.
 *
 * The guard detects, it does not prevent: the worktree is left exactly as the step left it when a
 * violation is found, and a turn that only reads completes normally.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryStorage, type TaskInspection } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import type {
  AgentLaunch,
  AgentStatusInput,
  LaunchInput,
  StepAgentStatus,
  StepExecutor,
} from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import type { StepCheckpoint } from "../../src/durable/tasks/step.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR, RoleIR } from "../../src/playbook/ir.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo } from "../support/git.js";
import { driveIo, makeTempHome } from "./support.js";

const READ_ONLY: RoleIR = {
  id: "reviewer",
  title: "Reviewer",
  readonly: true,
  instructions: "Read the change. Do not write.",
  fallbacks: [],
};

const READ_WRITE: RoleIR = { ...READ_ONLY, id: "implementer", readonly: false };

function reviewedPlaybook(role: RoleIR): PlaybookIR {
  return playbook({ id: "reviewed", steps: [step({ id: "review", role })] });
}

/** An executor whose first status poll writes inside the working tree (a violating agent). */
class WritingExecutor implements StepExecutor {
  readonly files: string[] = [];
  #wrote = false;

  constructor(private readonly relativePath: string) {}

  async launch(input: LaunchInput): Promise<AgentLaunch> {
    return { agentId: "agent-writer", ...(input.target === undefined ? {} : { target: input.target }) };
  }

  async status(input: AgentStatusInput): Promise<StepAgentStatus> {
    if (!this.#wrote) {
      writeFileSync(join(input.cwd, this.relativePath), "the step should not have written this\n");
      this.files.push(input.cwd);
      this.#wrote = true;
    }
    return { state: "done", outcome: "success" };
  }
}

/** The live `argos.step` task of one step id (checkpoints live only while the task is live). */
async function stepTaskOf(host: ArgosHost, stepId: string): Promise<TaskInspection | undefined> {
  const inspection = await host.inspect();
  return inspection.tasks.find(
    (candidate) =>
      candidate.record.kind === "argos.step" &&
      (candidate.record.input as { stepId?: string }).stepId === stepId,
  );
}

function checkpointOf(task: TaskInspection | undefined): StepCheckpoint | undefined {
  const state = task?.record.state as { checkpoint?: StepCheckpoint } | undefined;
  return state?.checkpoint;
}

describe("read-only guard (D8)", () => {
  it("fails a read-only turn that writes with readonly_violation and keeps the worktree", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const clock = new FakeClock();
    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      home,
      clock,
      executor: new WritingExecutor("agent-note.txt"),
    });
    try {
      const runId = "run-readonly-writes";
      const { runId: started } = await host.startRun({
        ir: reviewedPlaybook(READ_ONLY),
        inputs: {},
        cwd: repo.repo,
        id: runId,
        isolation: { mode: "worktree" },
      });
      await driveIo(clock, async () => {
        const status = (await host.getRun(started))?.record.status;
        return status === "failed" || status === "completed";
      });

      const record = (await host.getRun(started))?.record;
      expect(record?.status).toBe("failed");
      expect(record?.errorCode).toBe("readonly_violation");
      expect(record?.steps["review"]?.status).toBe("failed");
      expect(record?.steps["review"]?.errorCode).toBe("readonly_violation");

      // Never silently complete: the step produced no outputs from a violating turn.
      expect(record?.steps["review"]?.outputs).toEqual({});

      // The worktree is preserved for inspection and still holds what the step wrote.
      const worktree = record?.worktree?.path ?? "";
      expect(worktree).toBe(join(home, "worktrees", runId));
      expect(existsSync(worktree)).toBe(true);
      expect(existsSync(join(worktree, "agent-note.txt"))).toBe(true);
      // The source checkout is untouched.
      expect(existsSync(join(repo.repo, "agent-note.txt"))).toBe(false);
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("completes a read-only turn that only reads, with the before-snapshot in the checkpoint", async () => {
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
      const { runId } = await host.startRun({
        ir: reviewedPlaybook(READ_ONLY),
        inputs: {},
        cwd: repo.repo,
        id: "run-readonly-reads",
      });
      // The step parks in its poll loop; the snapshot is already committed by `locate`.
      await driveIo(clock, async () => (await stepTaskOf(host, "review"))?.state.kind === "sleeping");
      const live = await stepTaskOf(host, "review");
      const before = checkpointOf(live)?.snapshotBefore;
      expect(before?.head).toBe(repo.headSha);
      expect(before?.files).toEqual([]);

      executor.completeAll();
      await driveIo(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      const record = (await host.getRun(runId))?.record;
      expect(record?.status).toBe("completed");
      expect(record?.steps["review"]?.status).toBe("completed");
      expect(record?.steps["review"]?.errorCode).toBeUndefined();
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });

  it("does not snapshot a step whose role is not read-only", async () => {
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
      const { runId } = await host.startRun({
        ir: reviewedPlaybook(READ_WRITE),
        inputs: {},
        cwd: repo.repo,
        id: "run-readwrite",
      });
      await driveIo(clock, async () => (await stepTaskOf(host, "review"))?.state.kind === "sleeping");
      const live = await stepTaskOf(host, "review");
      expect(checkpointOf(live)?.snapshotBefore).toBeUndefined();
      expect(live?.record.input as { readonly?: boolean }).not.toHaveProperty("readonly", true);

      executor.completeAll();
      await driveIo(clock, async () => (await host.getRun(runId))?.record.status === "completed");
      expect((await host.getRun(runId))?.record.status).toBe("completed");
    } finally {
      await host.close();
      cleanup();
      repo.cleanup();
    }
  });
});
