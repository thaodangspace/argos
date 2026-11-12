/**
 * `argos worktree rm|gc` (FR4.6) — manual cleanup of `$ARGOS_HOME/worktrees`.
 *
 * The sub-command is parsed by hand (the same shape as the rest of the CLI: no dependency), and
 * every request goes through `argos serve`: the CLI never touches a working tree or SQLite. The
 * server derives the path and branch from the run record (FR4.4), so nothing here ever sends a path.
 */

import { flag, hasFlag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";

export async function worktreeCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const [sub, ...rest] = args.positionals;
  if (sub === "rm") return removeWorktreeCommand(args, io, rest);
  if (sub === "gc") return gcWorktreeCommand(args, io, rest);
  io.stderr("argos: worktree needs a sub-command (rm <runId> | gc --older-than <dur>)\n");
  return EXIT_RUNTIME;
}

async function removeWorktreeCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["force", "delete-branch"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  const runId = positionals[0];
  if (runId === undefined) {
    io.stderr("argos: worktree rm needs a run id\n");
    return EXIT_RUNTIME;
  }
  if (positionals.length > 1) {
    io.stderr("argos: worktree rm takes exactly one run id\n");
    return EXIT_RUNTIME;
  }
  const force = hasFlag(args, "force");
  const deleteBranch = hasFlag(args, "delete-branch");
  return withRpc(io, args.json, async (client) => {
    const result = await client.removeWorktree(runId, {
      ...(force ? { force: true } : {}),
      ...(deleteBranch ? { deleteBranch: true } : {}),
    });
    const branch = result.branchDeleted
      ? "; deleted its branch"
      : deleteBranch
        ? "; the branch was kept (merge it first, or pass --force)"
        : "";
    return {
      jsonValue: result,
      human: result.removed
        ? `removed worktree ${result.path} of run ${result.runId}${branch}`
        : `run ${result.runId} has no worktree to remove${branch}`,
    };
  });
}

async function gcWorktreeCommand(
  args: ParsedArgs,
  io: CliIo,
  positionals: readonly string[],
): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["older-than", "force", "delete-branch", "dry-run"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (positionals.length > 0) {
    io.stderr("argos: worktree gc takes no run id; it works from --older-than\n");
    return EXIT_RUNTIME;
  }
  const olderThan = flag(args, "older-than");
  if (olderThan === undefined) {
    io.stderr("argos: worktree gc needs --older-than <n>(s|m|h|d), e.g. --older-than 24h\n");
    return EXIT_RUNTIME;
  }
  const force = hasFlag(args, "force");
  const deleteBranch = hasFlag(args, "delete-branch");
  const dryRun = hasFlag(args, "dry-run");
  return withRpc(io, args.json, async (client) => {
    const result = await client.gcWorktrees({
      olderThan,
      ...(dryRun ? { dryRun: true } : {}),
      ...(force ? { force: true } : {}),
      ...(deleteBranch ? { deleteBranch: true } : {}),
    });
    const verb = dryRun ? "would remove" : "removed";
    const branches = result.removed.filter((entry) => entry.branchDeleted).length;
    const skip = result.skipped.map((entry) => `${entry.runId} (${entry.reason})`).join(", ");
    return {
      jsonValue: result,
      human:
        `${verb} ${result.removed.length} worktree(s)` +
        (branches > 0 ? `, ${branches} branch(es)` : "") +
        `; skipped ${result.skipped.length}${skip === "" ? "" : `: ${skip}`}` +
        `; ${result.orphans.length} orphan director${result.orphans.length === 1 ? "y" : "ies"} reported`,
    };
  });
}
