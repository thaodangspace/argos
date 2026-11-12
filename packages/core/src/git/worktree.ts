/**
 * D9: per-run worktree isolation (FR23) — every command is `execFile("git", [...])`, no shell and
 * no git library.
 *
 * Layout: `<ARGOS_HOME>/worktrees/<runId>` on branch `argos/<runId>`, created from
 * `origin/<base>` **after a fetch**, so the run starts from the remote's current base rather than
 * from whatever the operator's checkout happens to contain. `{path, branch, baseSha}` is stored in
 * the run record's `worktree` and every agent and script then works in that directory.
 *
 * Base resolution, in order (documented so `argos doctor` can explain a refusal):
 * 1. `isolation.base` when the playbook names one;
 * 2. `refs/remotes/origin/HEAD` (`origin/main` in a normal clone);
 * 3. the branch the repository is currently on, when `origin/<branch>` exists;
 * 4. `origin/main`, then `origin/master`.
 * A base that does not resolve to a commit is `worktree_failed`; a source checkout with
 * uncommitted changes is `worktree_base_dirty` and is refused **before** `git worktree add`.
 *
 * Idempotency: creating the same run id twice (a restart between worktree creation and the run
 * task's first commit) returns the existing clean worktree instead of failing, and re-attaches the
 * branch if the checkout itself is missing. A dirty worktree is never silently reused.
 *
 * Removal is manual (`argos worktree rm`, `argos worktree gc`, FR4): `removeRunWorktree` refuses a
 * dirty checkout unless `force` is set and keeps `argos/<runId>` unless `deleteBranch` is set, and
 * `reattachRunWorktree` puts the same branch back so a removed worktree can still be retried.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { ArgosError } from "../errors.js";
import {
  execFileGit,
  isSafeRefName,
  tail,
  GitCommandError,
  type GitInvocation,
  type GitRunner,
} from "./exec.js";

/** Subdirectory of `$ARGOS_HOME` that holds run worktrees. */
export const WORKTREES_DIR_NAME = "worktrees";

/** The branch prefix owned by Argos. */
export const RUN_BRANCH_PREFIX = "argos/";

/** `{path, branch, baseSha}`, the run record's `worktree` field (engine `WorktreeRecord`). */
export interface RunWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

export interface CreateRunWorktreeInput {
  /** The source checkout the worktree is cut from (the run's `cwd`). */
  readonly repo: string;
  /** `$ARGOS_HOME`; the worktree lives under `<home>/worktrees/<runId>`. */
  readonly home: string;
  /** Run id (ULID); also the branch suffix. */
  readonly runId: string;
  /** `isolation.base`; default: the repository's default branch (see the module comment). */
  readonly base?: string;
  readonly git?: GitRunner;
}

export interface RemoveRunWorktreeInput {
  readonly repo: string;
  readonly home: string;
  readonly runId: string;
  /** Remove a worktree with local modifications (default `false`: refuse). */
  readonly force?: boolean;
  /** Delete `argos/<runId>` too (default `false`: keep the branch). */
  readonly deleteBranch?: boolean;
  readonly git?: GitRunner;
}

/** What {@link removeRunWorktree} did: the checkout (when present) and the branch. */
export interface RemoveRunWorktreeResult {
  readonly removed: boolean;
  readonly path: string;
  /**
   * True only when `deleteBranch` was asked for **and** `git branch -d`/`-D` succeeded. An
   * unmerged branch without `force` is reported here as `false` (the branch is kept), not thrown:
   * the worktree is already gone and gc reports per-run outcomes.
   */
  readonly branchDeleted: boolean;
}

export interface ReattachRunWorktreeInput {
  /** The source checkout the worktree belongs to (the run's `cwd`). */
  readonly repo: string;
  readonly home: string;
  readonly runId: string;
  readonly git?: GitRunner;
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
}

/** `<home>/worktrees/<runId>`. */
export function runWorktreePath(home: string, runId: string): string {
  return join(home, WORKTREES_DIR_NAME, runId);
}

/** `argos/<runId>`. */
export function runWorktreeBranch(runId: string): string {
  return `${RUN_BRANCH_PREFIX}${runId}`;
}

// ------------------------------------------------------------------ helpers

interface Context {
  readonly repo: string;
  readonly git: GitRunner;
}

/** Run one git command, mapping a failure to `worktree_failed` with the redacted stderr tail. */
async function gitOr(
  context: Context,
  args: readonly string[],
  what: string,
  cwd: string = context.repo,
): Promise<string> {
  const invocation: GitInvocation = { cwd, args: [...args] };
  try {
    const result = await context.git(invocation);
    return result.stdout;
  } catch (error) {
    const detail = error instanceof GitCommandError ? error.stderr : String(error);
    throw new ArgosError(
      "worktree_failed",
      `${context.repo}: ${what} failed (git ${args.join(" ")})${detail === "" ? "" : `: ${tail(detail)}`}`,
      { cause: error },
    );
  }
}

/** Run a probe command; `undefined` when git exits non-zero (an absent ref is not an error here). */
async function probe(context: Context, args: readonly string[]): Promise<string | undefined> {
  try {
    return (await context.git({ cwd: context.repo, args: [...args] })).stdout.trim();
  } catch {
    return undefined;
  }
}

/** Canonical form of a path that may not exist yet (macOS resolves `/var` to `/private/var`). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/** Parse `git worktree list --porcelain -z` (records are separated by an empty field). */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    bare: boolean;
    detached: boolean;
  } = { bare: false, detached: false };

  const flush = (): void => {
    if (current.path === undefined) return;
    entries.push({
      path: current.path,
      ...(current.head === undefined ? {} : { head: current.head }),
      ...(current.branch === undefined ? {} : { branch: current.branch }),
      bare: current.bare,
      detached: current.detached,
    });
    current = { bare: false, detached: false };
  };

  for (const token of stdout.split("\0")) {
    if (token === "") {
      flush();
      continue;
    }
    const space = token.indexOf(" ");
    const key = space === -1 ? token : token.slice(0, space);
    const value = space === -1 ? "" : token.slice(space + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
  }
  flush();
  return entries;
}

/** Every worktree git knows about for `repo`. */
export async function listRunWorktrees(input: {
  readonly repo: string;
  readonly git?: GitRunner;
}): Promise<readonly WorktreeEntry[]> {
  const context: Context = { repo: input.repo, git: input.git ?? execFileGit };
  const stdout = await gitOr(context, ["worktree", "list", "--porcelain", "-z"], "list worktrees");
  return parseWorktreeList(stdout);
}

/** Strip a leading `origin/` (both `origin/main` and `refs/remotes/origin/main` forms). */
function localBranchName(ref: string): string {
  let name = ref.trim();
  if (name.startsWith("refs/remotes/origin/")) name = name.slice("refs/remotes/origin/".length);
  else if (name.startsWith("origin/")) name = name.slice("origin/".length);
  return name;
}

async function originRefExists(context: Context, name: string): Promise<boolean> {
  if (!isSafeRefName(name)) return false;
  return (await probe(context, ["rev-parse", "--quiet", "--verify", `origin/${name}^{commit}`])) !== undefined;
}

/** The base branch name, resolved without touching the working tree. */
async function defaultBaseName(context: Context): Promise<string> {
  const symbolic = await probe(context, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic !== undefined) {
    const name = localBranchName(symbolic);
    if (name !== "" && (await originRefExists(context, name))) return name;
  }
  const current = await probe(context, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== undefined && current !== "HEAD" && (await originRefExists(context, current))) {
    return current;
  }
  for (const candidate of ["main", "master"]) {
    if (await originRefExists(context, candidate)) return candidate;
  }
  throw new ArgosError(
    "worktree_failed",
    `${context.repo}: cannot determine the base branch (no origin/HEAD, no origin/main, no origin/master); set \`isolation.base\` to a branch that exists on origin`,
  );
}

/** The commit `origin/<name>` points at, after the fetch. */
async function resolveOriginCommit(context: Context, name: string): Promise<string> {
  try {
    const stdout = await gitOr(
      context,
      ["rev-parse", "--verify", `origin/${name}^{commit}`],
      `resolve base ref origin/${name}`,
    );
    const sha = stdout.trim();
    if (sha === "") throw new Error("empty rev-parse output");
    return sha;
  } catch (error) {
    if (error instanceof ArgosError && error.code === "worktree_failed") throw error;
    throw new ArgosError(
      "worktree_failed",
      `${context.repo}: cannot resolve base ref origin/${name}; run \`git fetch origin\` or set \`isolation.base\` to a branch that exists on origin`,
      { cause: error },
    );
  }
}

/** The base commit of an existing branch: its merge-base with the freshly fetched base. */
async function baseShaFor(
  context: Context,
  branchRef: string,
  baseName: string,
  fallback: string,
): Promise<string> {
  const mergeBase = await probe(context, ["merge-base", branchRef, `origin/${baseName}`]);
  return mergeBase === undefined || mergeBase === "" ? fallback : mergeBase;
}

async function assertWorktreeClean(context: Context, path: string): Promise<void> {
  const status = await gitOr(
    context,
    ["status", "--porcelain=v1", "-z"],
    `inspect existing worktree ${path}`,
    path,
  );
  if (status.trim() !== "") {
    throw new ArgosError(
      "worktree_failed",
      `${path}: the worktree of this run already exists with local changes; remove it with removeRunWorktree({ repo, home, runId, force: true }) before starting the run again`,
    );
  }
}

// ------------------------------------------------------------------ create

/**
 * Create (or re-adopt) the worktree of one run. Throws `worktree_base_dirty` when the source
 * checkout has uncommitted changes and `worktree_failed` for every other setup failure. Never
 * deletes anything.
 */
export async function createRunWorktree(input: CreateRunWorktreeInput): Promise<RunWorktree> {
  const context: Context = { repo: input.repo, git: input.git ?? execFileGit };
  const path = runWorktreePath(input.home, input.runId);
  const branch = runWorktreeBranch(input.runId);
  const branchRef = `refs/heads/${branch}`;

  // 1. A dirty source checkout would silently not be part of the run: the worktree is cut from a
  //    commit. Refuse before anything is created (FR23, spec edge case "Worktree creation fails").
  const sourceStatus = await gitOr(
    context,
    ["status", "--porcelain=v1", "-z"],
    "inspect the base working tree",
  );
  if (sourceStatus.trim() !== "") {
    throw new ArgosError(
      "worktree_base_dirty",
      `${input.repo}: the working tree has uncommitted changes, so a worktree of \`origin/\` would not contain them; commit or stash before starting an isolated run`,
    );
  }

  // 2. Fresh base: fetch first, then resolve. `--prune` drops branches deleted on the remote.
  await gitOr(context, ["fetch", "--prune", "--quiet", "origin"], "fetch origin");
  const explicitBase = input.base === undefined || input.base === "" ? undefined : input.base;
  if (explicitBase !== undefined && !isSafeRefName(explicitBase)) {
    throw new ArgosError(
      "worktree_failed",
      `${input.repo}: isolation.base ${JSON.stringify(explicitBase)} is not a valid branch name`,
    );
  }
  const baseName = explicitBase ?? (await defaultBaseName(context));
  const baseSha = await resolveOriginCommit(context, baseName);

  // 3. Restart path: the same run id already has its worktree. Reuse it when it is clean; never
  //    renumber or re-create it (the run record may already reference it).
  const canonicalPath = canonical(path);
  const existing = (await listRunWorktrees({ repo: input.repo, ...(input.git === undefined ? {} : { git: input.git }) })).find(
    (entry) => canonical(entry.path) === canonicalPath,
  );
  if (existing !== undefined) {
    if (existing.branch !== branchRef) {
      throw new ArgosError(
        "worktree_failed",
        `${path}: already registered as ${existing.branch ?? "a detached worktree"}, not ${branchRef}; remove it before starting run ${input.runId} again`,
      );
    }
    await assertWorktreeClean(context, path);
    return {
      path,
      branch,
      baseSha: await baseShaFor(context, branchRef, baseName, baseSha),
    };
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const branchExists = (await probe(context, ["rev-parse", "--quiet", "--verify", branchRef])) !== undefined;
  if (branchExists) {
    // The branch survived a crash between `worktree add` steps: re-attach it instead of failing.
    await gitOr(context, ["worktree", "add", path, branch], `re-attach ${branchRef} at ${path}`);
  } else {
    await gitOr(
      context,
      ["worktree", "add", "-b", branch, path, `origin/${baseName}`],
      `create worktree ${path} from origin/${baseName}`,
    );
  }

  return { path, branch, baseSha };
}

// ------------------------------------------------------------------ cleanup

/**
 * Refuse a worktree that still has uncommitted (or untracked) changes unless `force` is set
 * (FR4.2). The message names the flag the caller has to pass, so `argos worktree rm` can be
 * retried as printed.
 */
async function assertWorktreeRemovable(context: Context, path: string): Promise<void> {
  const status = await gitOr(
    context,
    ["status", "--porcelain=v1", "-z"],
    `inspect worktree ${path}`,
    path,
  );
  if (status.trim() !== "") {
    throw new ArgosError(
      "worktree_failed",
      `${path}: the worktree has local changes; pass --force (removeRunWorktree({ force: true })) to remove it and lose them`,
    );
  }
}

/**
 * Delete `argos/<runId>` (FR4.3): `git branch -d`, or `-D` with `force`. Returns `false` — without
 * throwing — when the branch does not exist or git refuses (an unmerged branch): the worktree is
 * already gone by then, so the outcome belongs in the receipt, not in an exception.
 */
async function deleteRunBranch(context: Context, runId: string, force: boolean): Promise<boolean> {
  const branch = runWorktreeBranch(runId);
  const exists =
    (await probe(context, ["rev-parse", "--quiet", "--verify", `refs/heads/${branch}`])) !==
    undefined;
  if (!exists) return false;
  try {
    await context.git({ cwd: context.repo, args: ["branch", force ? "-D" : "-d", branch] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove one run's worktree (never automatic). The branch is kept by default, so committed work
 * can still be inspected or pushed after the directory is gone; `deleteBranch` removes it too.
 * Without `force` a dirty worktree is refused with `worktree_failed` before git is asked.
 */
export async function removeRunWorktree(
  input: RemoveRunWorktreeInput,
): Promise<RemoveRunWorktreeResult> {
  const context: Context = { repo: input.repo, git: input.git ?? execFileGit };
  const path = runWorktreePath(input.home, input.runId);
  const canonicalPath = canonical(path);
  const existing = (await listRunWorktrees({
    repo: input.repo,
    ...(input.git === undefined ? {} : { git: input.git }),
  })).find((entry) => canonical(entry.path) === canonicalPath);

  let removed = false;
  if (existing !== undefined) {
    if (input.force !== true) await assertWorktreeRemovable(context, path);
    const args = ["worktree", "remove"];
    if (input.force === true) args.push("--force");
    args.push(path);
    await gitOr(context, args, `remove worktree ${path}`);
    removed = true;
  }

  const branchDeleted =
    input.deleteBranch === true
      ? await deleteRunBranch(context, input.runId, input.force === true)
      : false;
  return { removed, path, branchDeleted };
}

/**
 * Attach `argos/<runId>` to `<home>/worktrees/<runId>` again (FR4.7): a retry after
 * `argos worktree rm` reuses the branch's commits instead of re-cutting the checkout from the base.
 * Prune first, so a directory deleted out of band leaves no stale registration behind. A branch
 * that is gone is `worktree_failed` — Argos never re-creates the worktree from the base here.
 */
export async function reattachRunWorktree(
  input: ReattachRunWorktreeInput,
): Promise<{ readonly path: string; readonly branch: string }> {
  const context: Context = { repo: input.repo, git: input.git ?? execFileGit };
  const path = runWorktreePath(input.home, input.runId);
  const branch = runWorktreeBranch(input.runId);
  const exists =
    (await probe(context, ["rev-parse", "--quiet", "--verify", `refs/heads/${branch}`])) !==
    undefined;
  if (!exists) {
    throw new ArgosError(
      "worktree_failed",
      `${input.repo}: branch ${branch} no longer exists, so the worktree of run ${input.runId} cannot be re-attached; its commits are gone (delete the branch only when the run does not need to be retried)`,
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await gitOr(context, ["worktree", "prune"], "prune stale worktrees");
  await gitOr(context, ["worktree", "add", path, branch], `re-attach ${branch} at ${path}`);
  return { path, branch };
}
