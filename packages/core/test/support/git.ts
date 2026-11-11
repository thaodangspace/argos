/**
 * Temp-repository helpers for the Phase 7 tests (not a test file itself).
 *
 * Every repository lives under `os.tmpdir()` and is removed by `cleanup()`. Nothing here touches
 * the network: `origin` is a local bare repository, so `git fetch origin` is a local file copy and
 * the base sha is deterministic.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  /** Root of the scratch directory (holds the checkout and its bare origin). */
  readonly root: string;
  /** The source checkout (a normal repository with `origin`). */
  readonly repo: string;
  /** The local bare repository standing in for the remote. */
  readonly origin: string;
  /** Sha of the initial commit on `main`, which `origin/main` and `origin/HEAD` point at. */
  readonly headSha: string;
  /** Run git in `cwd` (default: the checkout) and return trimmed stdout. */
  git(args: readonly string[], cwd?: string): string;
  cleanup(): void;
}

function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

export interface TempRepoOptions {
  /** Name of the initial branch (default `main`). */
  readonly branch?: string;
  /**
   * Point `refs/remotes/origin/HEAD` at `origin/<branch>` (default `true`). Set to `false` to
   * exercise the documented fallback chain (current branch, then `main`, then `master`).
   */
  readonly setOriginHead?: boolean;
}

/** A checkout with a bare `origin`, one pushed commit, and a configured `origin/HEAD`. */
export function makeTempRepo(options: TempRepoOptions = {}): TempRepo {
  const branch = options.branch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "argos-git-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  execFileSync("git", ["init", "--quiet", "--bare", `--initial-branch=${branch}`, origin], {
    encoding: "utf8",
  });
  mkdirSync(repo, { recursive: true });
  const git = (args: readonly string[], cwd: string = repo): string => gitIn(cwd, args);

  git(["init", "--quiet", `--initial-branch=${branch}`]);
  git(["config", "user.email", "argos@example.test"]);
  git(["config", "user.name", "Argos Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "initial commit"]);
  git(["remote", "add", "origin", origin]);
  git(["push", "--quiet", "-u", "origin", branch]);
  if (options.setOriginHead !== false) {
    git(["remote", "set-head", "origin", "--auto"]);
  }
  const headSha = git(["rev-parse", "HEAD"]);

  return {
    root,
    repo,
    origin,
    headSha,
    git,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Write an executable script into `<repo>/.argos/scripts/<name>` (mode `0755`). */
export function writeScript(repo: string, name: string, body: string): string {
  const path = join(repo, ".argos", "scripts", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** Copy a fixture script (`test/fixtures/scripts/<name>`) into the repo, executable. */
export function installFixtureScript(repo: string, name: string): string {
  const source = new URL(`../fixtures/scripts/${name}`, import.meta.url);
  const target = join(repo, ".argos", "scripts", name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  chmodSync(target, 0o755);
  return target;
}
