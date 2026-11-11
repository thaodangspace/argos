/**
 * D8: the read-only guard's evidence — a git snapshot before and after a step.
 *
 * A snapshot is `git rev-parse HEAD` plus `git status --porcelain=v1 -z`: one string for the
 * commit and one NUL-separated, unquoted entry list for the working tree. Comparing two snapshots
 * tells the engine whether a step touched the tree; it does **not** prevent the touch. That is the
 * documented limitation of the mechanism (inherited from paseo-playbooks): a read-only step can
 * still write while it runs, and the worktree is left in place for inspection when it does.
 *
 * What this cannot see, and why (documented again in `AGENTS.md`):
 * - a file created **and** deleted inside the step leaves no trace;
 * - a new file inside an already-untracked directory keeps the same `?? dir/` entry, because D8
 *   pins the default untracked mode rather than `--untracked-files=all`;
 * - `.git`-ignored paths are invisible by definition.
 */

import { execFileGit, tail, type GitRunner } from "./exec.js";

/** One `git status --porcelain=v1 -z` entry. `from` is set for renames/copies. */
export interface SnapshotFile {
  /** The two status letters (`XY`), exactly as git printed them. */
  readonly code: string;
  readonly path: string;
  readonly from?: string;
}

/** A checkpoint-safe snapshot of one working tree. */
export interface GitSnapshot {
  /** `HEAD` commit, or `null` in a repository with no commit yet. */
  readonly head: string | null;
  readonly files: readonly SnapshotFile[];
}

export interface SnapshotComparison {
  readonly changed: boolean;
  readonly headChanged: boolean;
  /** Paths whose status or presence differs, sorted. Empty when nothing changed. */
  readonly files: readonly string[];
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z"] as const;

/**
 * Parse `git status --porcelain=v1 -z`. Entries are NUL-separated; a rename/copy entry is followed
 * by the original path as its own NUL field. `XY` is kept, so a mode change (` M`) is distinct
 * from a staged change (`M `).
 */
export function parseStatusZ(stdout: string): SnapshotFile[] {
  const tokens = stdout.split("\0");
  const files: SnapshotFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "") continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    const renamed = code.startsWith("R") || code.startsWith("C");
    if (renamed) {
      const from = tokens[index + 1];
      index += 1;
      files.push(from === undefined || from === "" ? { code, path } : { code, path, from });
      continue;
    }
    files.push({ code, path });
  }
  return files;
}

/** Take one snapshot of `cwd`. Throws when `cwd` is not a git working tree. */
export async function takeSnapshot(
  cwd: string,
  options: { readonly git?: GitRunner } = {},
): Promise<GitSnapshot> {
  const git = options.git ?? execFileGit;
  const status = await git({ cwd, args: [...STATUS_ARGS] });
  let head: string | null = null;
  try {
    const resolved = await git({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
    const sha = resolved.stdout.trim();
    head = sha === "" ? null : sha;
  } catch {
    // A repository with no commit yet has no HEAD; `status` already succeeded, so this is not a
    // "not a repository" failure and the empty snapshot is the honest answer.
    head = null;
  }
  return { head, files: parseStatusZ(status.stdout) };
}

function fileKey(file: SnapshotFile): string {
  return file.from === undefined
    ? `${file.code} ${file.path}`
    : `${file.code} ${file.from} -> ${file.path}`;
}

/** Compare two snapshots: HEAD moved, or one entry was added, removed, or changed code. */
export function snapshotChanged(before: GitSnapshot, after: GitSnapshot): SnapshotComparison {
  const headChanged = before.head !== after.head;
  const beforeKeys = new Map(before.files.map((file) => [file.path, fileKey(file)] as const));
  const afterKeys = new Map(after.files.map((file) => [file.path, fileKey(file)] as const));
  const changedPaths = new Set<string>();
  for (const [path, key] of beforeKeys) {
    if (afterKeys.get(path) !== key) changedPaths.add(path);
  }
  for (const path of afterKeys.keys()) {
    if (!beforeKeys.has(path)) changedPaths.add(path);
  }
  const files = [...changedPaths].sort();
  return { changed: headChanged || files.length > 0, headChanged, files };
}

/** One-line, log-safe description of a comparison (no file contents, ever). */
export function describeSnapshotChange(comparison: SnapshotComparison, limit = 10): string {
  if (!comparison.changed) return "no change";
  const parts: string[] = [];
  if (comparison.headChanged) parts.push("HEAD moved");
  if (comparison.files.length > 0) {
    const shown = comparison.files.slice(0, limit);
    const suffix =
      comparison.files.length > shown.length
        ? ` and ${comparison.files.length - shown.length} more`
        : "";
    parts.push(`${shown.join(", ")}${suffix}`);
  }
  return tail(parts.join("; "));
}
