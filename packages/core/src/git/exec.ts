/**
 * The one way Argos runs `git` (D9): `execFile("git", [...])`, never a shell.
 *
 * Every call site passes an argument array, so a branch name, a path, or a base ref can never turn
 * into a shell command or an option (`--upload-pack=…`) — the worktree adapter validates names as
 * well, because defense in depth is cheap here. `GitRunner` is a type (not just a value) so tests
 * can inject a recording/faulting runner and assert the exact argv and cwd a refusal used.
 *
 * Errors carry a redacted stderr tail: a failing `git fetch` can echo the remote URL, which may
 * contain credentials, and that message ends up in a run-level throw.
 */

import { execFile } from "node:child_process";

import { isSecretEnvName } from "../engine/env.js";

/** One `git` invocation: argv plus the directory it runs in. No shell string, ever. */
export interface GitInvocation {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable git port (`execFile` in production, a recording fake in tests). */
export type GitRunner = (invocation: GitInvocation) => Promise<GitResult>;

/** The stderr/stdout bound a caller may echo into an error message. */
export const GIT_MESSAGE_LIMIT = 2_000;

/** Upper bound for a single git command's output (status/worktree listing on a big repo). */
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A conservative git ref component: letters, digits, `.`, `_`, `-`, `/`. It rejects the shapes
 * that make a ref dangerous or ambiguous (`..`, a leading `-`, `@{`, a trailing `/`).
 */
const SAFE_REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** True when `name` can be used as `origin/<name>` without quoting tricks. */
export function isSafeRefName(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  if (name.includes("..") || name.includes("@{") || name.endsWith("/") || name.endsWith(".lock")) {
    return false;
  }
  return SAFE_REF_NAME.test(name);
}

/** Keep the last `limit` characters, so the useful end of a git/program error survives. */
export function tail(text: string, limit: number = GIT_MESSAGE_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

/**
 * Remove credentials from a message that might echo them: values of secret-looking environment
 * variables, URL userinfo, `Bearer` tokens, and well-known provider key shapes.
 */
export function redactSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 6) continue;
    if (!isSecretEnvName(name)) continue;
    out = out.split(value).join("***");
  }
  out = out.replace(/\b(sk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "***");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer ***");
  out = out.replace(/\/\/[^/\s@]+:[^/\s@]+@/g, "//***:***@");
  return out;
}

/** A failed git command: argv, exit code, and the redacted stderr tail. */
export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly commandSignal: string | null;
  readonly stderr: string;

  constructor(init: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly exitCode: number | null;
    readonly commandSignal: string | null;
    readonly stderr: string;
    readonly cause?: unknown;
  }) {
    const detail = redactSecrets(tail(init.stderr));
    const status =
      init.exitCode !== null
        ? `exited ${init.exitCode}`
        : init.commandSignal !== null
          ? `killed by ${init.commandSignal}`
          : "failed to start";
    super(
      `git ${init.args.join(" ")} ${status}${detail === "" ? "" : `: ${detail}`}`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "GitCommandError";
    this.args = init.args;
    this.cwd = init.cwd;
    this.exitCode = init.exitCode;
    this.commandSignal = init.commandSignal;
    this.stderr = detail;
  }
}

/**
 * The production runner. `GIT_TERMINAL_PROMPT=0` keeps a private remote from blocking on a
 * password prompt inside `argos serve`; `GIT_OPTIONAL_LOCKS=0` keeps a `status` in a worktree an
 * agent is editing from fighting over `index.lock`.
 */
export const execFileGit: GitRunner = (invocation) =>
  new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      [...invocation.args],
      {
        cwd: invocation.cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: number | string };
        reject(
          new GitCommandError({
            args: [...invocation.args],
            cwd: invocation.cwd,
            exitCode: typeof failure.code === "number" ? failure.code : null,
            commandSignal: (error as { signal?: NodeJS.Signals | null }).signal ?? null,
            stderr: `${stderr ?? ""}${error.message}`,
            cause: error,
          }),
        );
      },
    );
  });
