/**
 * `argos db stats|purge|vacuum` — database maintenance.
 *
 * Every sub-command is an HTTP call: `argos serve` owns the database, the CLI only renders what it
 * answers. `stats` is read-only, `purge` retires terminal runs through the host's own `removeRun`
 * (with `--dry-run` reporting first), and `vacuum` compacts the file. A `--json` shape is the
 * contract in `@thaodangspace/argos-core/rpc`.
 */

import type { DbPurgeResponse, DbStats } from "@thaodangspace/argos-core/rpc";

import { flag, hasFlag, rejectUnknownFlags, type ParsedArgs } from "../args.js";
import { EXIT_RUNTIME, formatBytes, type CliIo } from "../output.js";
import { withRpc } from "../rpc-command.js";

export async function dbCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "stats") return statsCommand(args, io);
  if (sub === "purge") return purgeCommand(args, io);
  if (sub === "vacuum") return vacuumCommand(args, io);
  io.stderr(
    `argos: db needs a sub-command (stats | purge --older-than <dur> [--dry-run] [--vacuum] | vacuum)\n`,
  );
  return EXIT_RUNTIME;
}

async function statsCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: db stats takes no arguments\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const stats = await client.dbStats();
    return { jsonValue: stats, human: humanStats(stats) };
  });
}

async function purgeCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, ["older-than", "dry-run", "vacuum"]);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: db purge takes no positional arguments\n");
    return EXIT_RUNTIME;
  }
  const olderThan = flag(args, "older-than");
  if (olderThan === undefined) {
    io.stderr("argos: db purge needs --older-than <n>(s|m|h|d), e.g. --older-than 30d\n");
    return EXIT_RUNTIME;
  }
  const dryRun = hasFlag(args, "dry-run");
  const vacuum = hasFlag(args, "vacuum");
  return withRpc(io, args.json, async (client) => {
    const result = await client.purgeDb({
      olderThan,
      ...(dryRun ? { dryRun: true } : {}),
      ...(vacuum ? { vacuum: true } : {}),
    });
    return { jsonValue: result, human: humanPurge(result, olderThan) };
  });
}

async function vacuumCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const unknown = rejectUnknownFlags(args, []);
  if (unknown !== undefined) {
    io.stderr(`argos: ${unknown}\n`);
    return EXIT_RUNTIME;
  }
  if (args.positionals.length > 1) {
    io.stderr("argos: db vacuum takes no arguments\n");
    return EXIT_RUNTIME;
  }
  return withRpc(io, args.json, async (client) => {
    const result = await client.vacuumDb();
    return {
      jsonValue: result,
      human:
        `argos db vacuum: ${formatBytes(result.before.bytes)} -> ${formatBytes(result.after.bytes)}` +
        ` (wal ${formatBytes(result.before.walBytes)} -> ${formatBytes(result.after.walBytes)})`,
    };
  });
}

function humanStats(stats: DbStats): string {
  const lines = [
    `argos db  ${stats.path}`,
    `  size       ${formatBytes(stats.bytes)} (wal ${formatBytes(stats.walBytes)})`,
    `  pages      ${stats.pageCount} × ${stats.pageSize} B (${stats.freePages} free)`,
    `  journal    ${stats.journalMode}`,
    `  runs       ${stats.runs.total} total (${stats.runs.active} active)`,
    `  documents  ${stats.documents.total} (${stats.documents.live} live, ${stats.documents.retired} retired)`,
    `  tasks      ${stats.tasks.total} (${stats.tasks.live} live, ${stats.tasks.terminal} terminal)`,
    `  revisions  ${stats.revisions}`,
    `  receipts   ${stats.receipts.total} (${stats.receipts.expired} expired)`,
  ];
  const taskKinds = stats.tasks.byKind.filter((kind) => kind.terminal > 0);
  if (taskKinds.length > 0) {
    lines.push(
      `  terminal   ${taskKinds
        .map((kind) => `${kind.kind} ${kind.terminal}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function humanPurge(result: DbPurgeResponse, olderThan: string): string {
  const verb = result.dryRun ? "would remove" : "removed";
  const lines = [
    `${result.dryRun ? "argos db purge (dry run)" : "argos db purge"}: ${verb} ${result.removed.length} run(s)` +
      ` older than ${olderThan}`,
    `  tasks      ${result.tasksRemoved} terminal task row(s) ${result.dryRun ? "would be reclaimed" : "reclaimed"}`,
    `  receipts   ${result.receiptsRetired} expired idempotency receipt(s) ${result.dryRun ? "would be retired" : "retired"}`,
  ];
  if (result.skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const skipped of result.skipped) {
      reasons.set(skipped.reason, (reasons.get(skipped.reason) ?? 0) + 1);
    }
    lines.push(
      `  skipped    ${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ")}`,
    );
  }
  lines.push(
    `  size       ${formatBytes(result.before.bytes)} -> ${formatBytes(result.after.bytes)}` +
      (result.vacuumed ? " (vacuumed)" : ""),
  );
  return lines.join("\n");
}
