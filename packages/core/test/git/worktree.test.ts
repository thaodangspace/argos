/**
 * D9 worktree creation (FR23) — real git, a local bare `origin`, temp directories only.
 *
 * The assertions are the contract: layout `<ARGOS_HOME>/worktrees/<runId>`, branch
 * `argos/<runId>`, base from the fetched `origin/<base>`, `worktree_base_dirty` before anything is
 * created, `worktree_failed` for a base that does not resolve, and an argv-only git port.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";

import { isArgosError } from "../../src/errors.js";
import { execFileGit, type GitInvocation, type GitRunner } from "../../src/git/exec.js";
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

describe("createRunWorktree (D9)", () => {
  it("creates <home>/worktrees/<runId> on argos/<runId> from a freshly fetched origin/<base>", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      // Drop the local remote-tracking ref: only `git fetch` can tell us where `origin/main` is,
      // which is what proves the base comes from a fetch and not from the checkout's stale memory.
      repo.git(["update-ref", "-d", "refs/remotes/origin/main"]);
      expect(() => repo.git(["rev-parse", "--verify", "origin/main"])).toThrow();

      const worktree = await createRunWorktree({ repo: repo.repo, home, runId: "01RUNP7" });

      expect(worktree.path).toBe(runWorktreePath(home, "01RUNP7"));
      expect(worktree.path).toBe(join(home, "worktrees", "01RUNP7"));
      expect(worktree.branch).toBe("argos/01RUNP7");
      expect(runWorktreeBranch("01RUNP7")).toBe("argos/01RUNP7");
      expect(worktree.baseSha).toBe(repo.headSha);

      // The fetch really happened, and the worktree is a real checkout of the base commit.
      expect(repo.git(["rev-parse", "origin/main"])).toBe(repo.headSha);
      expect(repo.git(["rev-parse", "HEAD"], worktree.path)).toBe(repo.headSha);
      expect(repo.git(["rev-parse", "--abbrev-ref", "HEAD"], worktree.path)).toBe(
        "argos/01RUNP7",
      );
      expect(existsSync(join(worktree.path, "README.md"))).toBe(true);

      const listed = await listRunWorktrees({ repo: repo.repo });
      expect(listed.map((entry) => entry.branch)).toContain("refs/heads/argos/01RUNP7");
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("uses isolation.base when the playbook names one", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      repo.git(["checkout", "--quiet", "-b", "release"]);
      repo.git(["push", "--quiet", "-u", "origin", "release"]);
      const releaseSha = repo.git(["rev-parse", "HEAD"]);
      repo.git(["checkout", "--quiet", "main"]);
      repo.git(["update-ref", "-d", "refs/remotes/origin/release"]);

      const worktree = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "01RUNBASE",
        base: "release",
      });
      expect(worktree.baseSha).toBe(releaseSha);
      expect(repo.git(["rev-parse", "HEAD"], worktree.path)).toBe(releaseSha);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("falls back to the current branch (then main/master) when origin/HEAD is absent", async () => {
    const repo = makeTempRepo({ branch: "trunk", setOriginHead: false });
    const { home, cleanup } = makeTempHome();
    try {
      expect(() => repo.git(["rev-parse", "--verify", "origin/HEAD"])).toThrow();
      const worktree = await createRunWorktree({ repo: repo.repo, home, runId: "01RUNTRUNK" });
      expect(worktree.baseSha).toBe(repo.headSha);
      expect(repo.git(["rev-parse", "HEAD"], worktree.path)).toBe(repo.headSha);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("refuses a dirty base with worktree_base_dirty and creates nothing", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      repo.git(["status", "--porcelain=v1"]); // clean
      writeFileSync(join(repo.repo, "uncommitted.txt"), "work in progress\n");

      const error = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "01RUNDIRTY" }),
      );
      expect(codeOf(error)).toBe("worktree_base_dirty");
      expect((error as Error).message).toContain("uncommitted");
      expect(existsSync(runWorktreePath(home, "01RUNDIRTY"))).toBe(false);
      expect(() => repo.git(["rev-parse", "--verify", "refs/heads/argos/01RUNDIRTY"])).toThrow();
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("fails with worktree_failed for a base ref that does not resolve", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const error = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "01RUNNOPE", base: "does-not-exist" }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("origin/does-not-exist");
      expect(existsSync(runWorktreePath(home, "01RUNNOPE"))).toBe(false);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("rejects an isolation.base that is not a plain branch name", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const error = await errorOf(
        createRunWorktree({
          repo: repo.repo,
          home,
          runId: "01RUNINJECT",
          base: "--upload-pack=/bin/sh",
        }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("not a valid branch name");
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("is idempotent for the same run id and refuses to reuse a dirty worktree", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const first = await createRunWorktree({ repo: repo.repo, home, runId: "01RUNIDEM" });
      const second = await createRunWorktree({ repo: repo.repo, home, runId: "01RUNIDEM" });
      expect(second).toEqual(first);

      writeFileSync(join(first.path, "agent-change.txt"), "not committed\n");
      const error = await errorOf(
        createRunWorktree({ repo: repo.repo, home, runId: "01RUNIDEM" }),
      );
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("local changes");
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("removes the checkout but keeps the branch", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      const worktree = await createRunWorktree({ repo: repo.repo, home, runId: "01RUNCLEAN" });
      const removed = await removeRunWorktree({ repo: repo.repo, home, runId: "01RUNCLEAN" });
      expect(removed).toEqual({ removed: true, path: worktree.path });
      expect(existsSync(worktree.path)).toBe(false);
      expect(repo.git(["rev-parse", "--verify", "refs/heads/argos/01RUNCLEAN"])).toBe(repo.headSha);
      // Idempotent: nothing left to remove.
      expect(await removeRunWorktree({ repo: repo.repo, home, runId: "01RUNCLEAN" })).toEqual({
        removed: false,
        path: worktree.path,
      });
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("passes git an argv array, so a metacharacter path is just a path", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const awkward = join(repo.root, "repo with space; $(touch pwned) 'quote'");
    const awkwardOrigin = join(repo.root, "awkward origin.git");
    try {
      execFileSync("git", ["init", "--quiet", "--bare", awkwardOrigin], { encoding: "utf8" });
      mkdirSync(awkward, { recursive: true });
      repo.git(["init", "--quiet"], awkward);
      repo.git(["config", "user.email", "argos@example.test"], awkward);
      repo.git(["config", "user.name", "Argos Test"], awkward);
      repo.git(["remote", "add", "origin", awkwardOrigin], awkward);
      writeFileSync(join(awkward, "README.md"), "# awkward\n");
      repo.git(["add", "README.md"], awkward);
      repo.git(["commit", "--quiet", "-m", "awkward"], awkward);
      repo.git(["push", "--quiet", "-u", "origin", "main"], awkward);

      const worktree = await createRunWorktree({ repo: awkward, home, runId: "01RUNARGV" });
      expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
      expect(existsSync(join(awkward, "pwned"))).toBe(false);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("uses exactly the D9 argv, always as an array with an explicit cwd", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    const calls: GitInvocation[] = [];
    const recording: GitRunner = (invocation) => {
      calls.push(invocation);
      return execFileGit(invocation);
    };
    try {
      const worktree = await createRunWorktree({
        repo: repo.repo,
        home,
        runId: "01RUNARGS",
        git: recording,
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(Array.isArray(call.args)).toBe(true);
        expect(call.args.every((arg) => typeof arg === "string")).toBe(true);
        expect(call.cwd).toBe(repo.repo);
      }
      expect(calls.map((call) => call.args)).toContainEqual([
        "worktree",
        "add",
        "-b",
        "argos/01RUNARGS",
        worktree.path,
        "origin/main",
      ]);
      expect(calls.map((call) => call.args)).toContainEqual([
        "fetch",
        "--prune",
        "--quiet",
        "origin",
      ]);
    } finally {
      cleanup();
      repo.cleanup();
    }
  });

  it("cannot create anything when there is no origin remote", async () => {
    const repo = makeTempRepo();
    const { home, cleanup } = makeTempHome();
    try {
      repo.git(["remote", "remove", "origin"]);
      const error = await errorOf(createRunWorktree({ repo: repo.repo, home, runId: "01RUNNOREMOTE" }));
      expect(codeOf(error)).toBe("worktree_failed");
      expect((error as Error).message).toContain("fetch origin");
    } finally {
      rmSync(join(home, "worktrees"), { recursive: true, force: true });
      cleanup();
      repo.cleanup();
    }
  });
});
