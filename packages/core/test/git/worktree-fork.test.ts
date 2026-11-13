/**
 * Fork worktrees (S-FR11) — real git, temp directories only.
 *
 * A fork must never share the parent's path or branch: `argos worktree rm`/`gc` derive both from
 * the record's own `runId`, so two runs in one checkout would break the record-only guard. The
 * fork therefore gets its own `argos/<forkRunId>` cut from the parent's branch, locally.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isArgosError } from "../../src/errors.js";
import type { GitInvocation } from "../../src/git/exec.js";
import { execFileGit } from "../../src/git/exec.js";
import {
  createRunWorktree,
  listRunWorktrees,
  removeRunWorktree,
  runWorktreeBranch,
  runWorktreePath,
} from "../../src/git/worktree.js";
import { makeTempHome } from "../durable/support.js";
import { makeTempRepo } from "../support/git.js";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

function codeOf(error: unknown): string | undefined {
  return isArgosError(error) ? error.code : undefined;
}

/** Run the git port while recording every argv, to prove what was (not) executed. */
function recordingGit(calls: string[][]): typeof execFileGit {
  return async (invocation: GitInvocation) => {
    calls.push([...invocation.args]);
    return execFileGit(invocation);
  };
}

describe("createRunWorktree({ from }) — fork base (S-FR11)", () => {
  it("cuts argos/<fork> from the parent branch and keeps the parent's commits", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const parent = await createRunWorktree({ repo: repo.repo, home, runId: "parent-1" });
      // Work the parent's run produced, left committed on its branch.
      writeFileSync(join(parent.path, "plan.md"), "the plan\n", "utf8");
      repo.git(["add", "plan.md"], parent.path);
      repo.git(["commit", "--quiet", "-m", "plan"], parent.path);
      const parentSha = repo.git(["rev-parse", "HEAD"], parent.path);

      const fork = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-1",
        from: runWorktreeBranch("parent-1"),
      });

      expect(fork.path).toBe(runWorktreePath(home, "fork-1"));
      expect(fork.path).not.toBe(parent.path);
      expect(fork.branch).toBe("argos/fork-1");
      expect(fork.baseSha).toBe(parentSha);
      expect(repo.git(["rev-parse", "HEAD"], fork.path)).toBe(parentSha);
      expect(existsSync(join(fork.path, "plan.md"))).toBe(true);
      // The provider's checkout is untouched: two independent worktrees on the same repository.
      expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"], parent.path)).toBe("argos/parent-1");
      expect(
        (await listRunWorktrees({ repo: repo.repo }))
          .map((entry) => entry.branch)
          .filter((branch) => branch?.includes("argos/"))
          .sort(),
      ).toEqual(["refs/heads/argos/fork-1", "refs/heads/argos/parent-1"]);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("never fetches and never checks the source checkout for dirt (offline, mid-edit)", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const parent = await createRunWorktree({ repo: repo.repo, home, runId: "parent-2" });
      // The operator is mid-edit: the source checkout is dirty, which refuses a normal isolated
      // run (`worktree_base_dirty`). A fork cuts from a local commit, so it must not care.
      writeFileSync(join(repo.repo, "notes.yaml"), "prompt: edited\n", "utf8");

      const calls: string[][] = [];
      const fork = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-2",
        from: runWorktreeBranch("parent-2"),
        git: recordingGit(calls),
      });

      expect(fork.baseSha).toBe(repo.git(["rev-parse", "HEAD"], parent.path));
      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      // The normal path still refuses the same state, so the exemption is specific to forks.
      const refused = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "normal-2" }),
      );
      expect(codeOf(refused)).toBe("worktree_base_dirty");
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses a missing parent branch with worktree_failed and creates nothing", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const error = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "fork-3", from: "argos/gone" }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect(error instanceof Error ? error.message : "").toContain("argos/gone");
      expect(existsSync(runWorktreePath(home, "fork-3"))).toBe(false);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses a fork base that is not a branch name (no argv injection)", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const error = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "fork-4", from: "--upload-pack=x" }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect(existsSync(runWorktreePath(home, "fork-4"))).toBe(false);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("re-attaches the fork's own branch after its directory is removed", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      await createRunWorktree({ repo: repo.repo, home, runId: "parent-5" });
      const fork = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-5",
        from: runWorktreeBranch("parent-5"),
      });
      const first = fork.baseSha;

      // The directory is gone (and git's admin entry pruned) but the branch survives — what
      // `re-attach` exists for, and what a crash between `worktree add` steps leaves behind.
      rmSync(fork.path, { recursive: true, force: true });
      repo.git(["worktree", "prune"]);
      const again = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-5",
        from: runWorktreeBranch("parent-5"),
      });
      expect(again.path).toBe(fork.path);
      expect(again.branch).toBe("argos/fork-5");
      expect(again.baseSha).toBe(first);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("keeps removeRunWorktree record-scoped: removing the fork never touches the parent", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const parent = await createRunWorktree({ repo: repo.repo, home, runId: "parent-6" });
      const fork = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-6",
        from: runWorktreeBranch("parent-6"),
      });

      const removed = await removeRunWorktree({
        repo: repo.repo,
        home,
        runId: "fork-6",
        force: false,
        deleteBranch: false,
      });
      expect(removed.removed).toBe(true);
      expect(existsSync(fork.path)).toBe(false);
      expect(existsSync(parent.path)).toBe(true);
      expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"], parent.path)).toBe("argos/parent-6");
    } finally {
      cleanup();
      repo.cleanup();
    }
  });
});
