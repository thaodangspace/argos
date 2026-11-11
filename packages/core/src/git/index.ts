/**
 * The git port (`argos-core` internal, D9).
 *
 * `src/git/` is the only directory (besides `src/durable/tasks/script.ts`) allowed to import
 * `node:child_process`; that is what keeps "no shell" and "no git library" true. It is not
 * re-exported from the package root for the same reason `src/durable/` is not: a client (CLI or
 * plugin) never needs to touch a working tree.
 */

export {
  execFileGit,
  GitCommandError,
  GIT_MAX_BUFFER,
  GIT_MESSAGE_LIMIT,
  isSafeRefName,
  redactSecrets,
  tail,
  type GitInvocation,
  type GitResult,
  type GitRunner,
} from "./exec.js";

export {
  describeSnapshotChange,
  parseStatusZ,
  snapshotChanged,
  takeSnapshot,
  type GitSnapshot,
  type SnapshotComparison,
  type SnapshotFile,
} from "./snapshot.js";

export {
  createRunWorktree,
  listRunWorktrees,
  parseWorktreeList,
  removeRunWorktree,
  runWorktreeBranch,
  runWorktreePath,
  RUN_BRANCH_PREFIX,
  WORKTREES_DIR_NAME,
  type CreateRunWorktreeInput,
  type RemoveRunWorktreeInput,
  type RunWorktree,
  type WorktreeEntry,
} from "./worktree.js";
