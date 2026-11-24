/**
 * Output, error, and exit-code conventions shared by every CLI command.
 *
 * Exit codes (documented in `AGENTS.md` and `argos --help`):
 *   0  success
 *   1  usage / runtime failure (including a bad flag, a missing server when not `run`, storage)
 *   2  playbook validation failure (`validate`, or `run` refusing an invalid playbook)
 *   3  unauthorized or unreachable server
 */

import { isArgosError } from "@thaodangspace/argos-core";
import { RpcClientError } from "@thaodangspace/argos-core/rpc";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_UNREACHABLE = 3;

/** Minimum Node for the built-in SQLite the durable host uses: unflagged from 22.13. */
export const REQUIRED_NODE_VERSION = ">=22.13";

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return (major as number) > 22 || ((major as number) === 22 && (minor as number) >= 13);
}

export function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** A JSON error body for `--json`; the same shape as the RPC `ErrorResponse`. */
export function printJsonError(io: CliIo, code: string, message: string): void {
  printJson(io, { error: { code, message } });
}

export function fail(io: CliIo, message: string): number {
  io.stderr(`argos: ${message}\n`);
  return EXIT_RUNTIME;
}

/** True for the errors that mean "the playbook itself is wrong" (exit 2, not 1). */
export function isValidationCode(code: string): boolean {
  return (
    code === "playbook_invalid" ||
    code === "playbook_cycle" ||
    code === "playbook_missing" ||
    code === "model_unavailable"
  );
}

/** Human text for an RPC failure, with the actionable next step the spec asks for (FR3). */
export function describeRpcError(error: RpcClientError, baseUrl: string, home: string): string {
  if (error.unreachable) {
    return `cannot reach the argos server at ${baseUrl} (${error.message}); start it with \`argos serve\``;
  }
  if (error.unauthorized) {
    return `unauthorized: ${error.message}; check ${home}/token or run \`argos doctor\``;
  }
  return `${error.code}: ${error.message}`;
}

/** Map any thrown value to `{ code, message, exitCode }` (no stack traces in output). */
export function classifyFailure(error: unknown): {
  code: string;
  message: string;
  exitCode: number;
} {
  if (error instanceof RpcClientError) {
    return {
      code: error.unreachable ? "unreachable" : error.code,
      message: error.message,
      exitCode: error.unreachable || error.unauthorized ? EXIT_UNREACHABLE : EXIT_RUNTIME,
    };
  }
  if (isArgosError(error)) {
    return {
      code: error.code,
      message: error.message,
      exitCode: isValidationCode(error.code) ? EXIT_VALIDATION : EXIT_RUNTIME,
    };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
    exitCode: EXIT_RUNTIME,
  };
}

/** `3.017` -> "$3.02"; `0.0042` -> "$0.0042"; `0` -> "$0". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** `6_322_750` -> "6.32M"; `35_982` -> "35.9k"; `130` -> "130". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1_000) return `${Math.round(value)}`;
  if (abs < 1_000_000) return `${trimZero((value / 1_000).toFixed(1))}k`;
  if (abs < 1_000_000_000) return `${trimZero((value / 1_000_000).toFixed(2))}M`;
  return `${trimZero((value / 1_000_000_000).toFixed(2))}B`;
}

/** `12_345_678` -> "11.8 MB"; `0` -> "0 B". Binary units, one decimal above a kilobyte. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(1)} ${units[unit]}`;
}

function trimZero(text: string): string {
  return text.replace(/\.?0+$/, "");
}

/**
 * One aggregate usage record as the CLI prints it: `$3.02 · 130 in · 35.9k out · 6.32M cached`.
 * Mirrors the plugin's `shared/format.ts` (the plugin cannot import the CLI package); unknown keys
 * are kept as `key=value`, so a new provider counter is visible without a code change.
 */
export function formatUsage(usage: Readonly<Record<string, number>> | undefined): string | null {
  if (usage === undefined) return null;
  const parts: string[] = [];
  const cost = usage["totalCostUsd"];
  if (cost !== undefined) parts.push(formatCost(cost));
  const input = usage["inputTokens"];
  const output = usage["outputTokens"];
  const cached = usage["cachedInputTokens"];
  if (input !== undefined) parts.push(`${formatTokens(input)} in`);
  if (output !== undefined) parts.push(`${formatTokens(output)} out`);
  if (cached !== undefined) parts.push(`${formatTokens(cached)} cached`);
  const context = usage["contextWindowUsedTokens"];
  const contextMax = usage["contextWindowMaxTokens"];
  if (context !== undefined && contextMax !== undefined) {
    parts.push(`ctx ${formatTokens(context)}/${formatTokens(contextMax)}`);
  }
  const known = new Set([
    "totalCostUsd",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "contextWindowUsedTokens",
    "contextWindowMaxTokens",
  ]);
  for (const [name, value] of Object.entries(usage)) {
    if (known.has(name)) continue;
    parts.push(`${name}=${formatTokens(value)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

export const USAGE = `argos — durable YAML playbooks for Paseo agents

Usage:
  argos validate [path] [--home dir] [--json]
  argos chart [path] [--playbook <id>] [--format mermaid|json] [--direction LR|TB] [--out <file>] [--run <id>] [--json]
  argos run <playbook> [--input k=v ...] [--cwd dir] [--isolation none|worktree]
                  [--executor paseo|hc] [--json]
  argos ls [--schedule <id>] [--json]
  argos status <runId> [--json]
  argos gates [--json]
  argos decide <runId> <gateId> <decision> [--comment text] [--json]
  argos cancel <runId> [--json]
  argos retry <runId> <stepId> [--json]
  argos fork <runId> <stepId> [--json]
  argos rm <runId> [--json]
  argos worktree rm <runId> [--force] [--delete-branch] [--json]
  argos worktree gc --older-than <n>(s|m|h|d) [--dry-run] [--force] [--delete-branch] [--json]
  argos schedule add <playbook> --cron <expr> [--id <id>] [--tz <zone>] [--cwd dir]
                     [--input k=v ...] [--isolation none|worktree] [--executor paseo|hc]
                     [--overlap skip|allow]
                     [--catch-up all|0|<n>(s|m|h|d)] [--keep <n>|all] [--paused] [--json]
  argos schedule edit <id> [--cron <expr>] [--tz <zone>] [--cwd dir] [--input k=v ...]
                     [--isolation none|worktree] [--executor paseo|hc] [--overlap skip|allow]
                     [--catch-up all|0|<n>(s|m|h|d)] [--keep <n>|all] [--json]
  argos schedule ls|show <id>|pause <id>|resume <id>|run <id>|rm <id> [--json]
  argos db stats [--json]
  argos db purge --older-than <n>(s|m|h|d) [--dry-run] [--vacuum] [--json]
  argos db vacuum [--json]
  argos serve [--port N] [--home dir] [--default-executor paseo|hc] [--json]
  argos doctor [--home dir] [--port N] [--json]

Environment:
  ARGOS_HOME      state directory (default ~/.argos)
  ARGOS_PORT      RPC port on 127.0.0.1 (default 7676)
  ARGOS_EXECUTOR  default substrate for argos serve (flag wins; default paseo)
  ARGOS_PASEO_URL Paseo daemon URL (argos serve only)
  ARGOS_FAKE_PASEO=1  test-only deterministic executor (argos serve only)

Exit codes: 0 success, 1 usage/runtime, 2 validation failure, 3 unauthorized/unreachable.
`;
