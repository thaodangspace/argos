/**
 * A real terminal for the raw-mode prompt-reader tests (`smoke.mjs`, `claude-step.mjs`).
 *
 * The readers only take their raw path when stdin is a tty, and `script` is the portable way to get
 * one without a native module. Its two implementations disagree on the command form:
 *
 *   BSD / macOS   `script [-q] file [command …]`
 *   util-linux    `script [options] [file]`, with `-c <command>` (and `-e` to return its status)
 *
 * The form is **probed** rather than keyed on `process.platform`, so the same suite runs on a
 * developer's macOS and on `ubuntu-latest` in CI. `packs.test.ts`-style suites only need the two
 * exports below; a machine without `script` (Windows) skips the pty cases entirely.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** `script`'s path, or `undefined` where this machine has none (Windows). */
export const scriptPath: string | undefined = ["/usr/bin/script", "/bin/script"].find((path) =>
  existsSync(path),
);

/** True for the util-linux build (`-c <command>`), false for the BSD one (trailing command list). */
const hasCommandFlag =
  scriptPath !== undefined &&
  spawnSync(scriptPath, ["-q", "-c", "exit 0", "/dev/null"], {
    stdio: "ignore",
    timeout: 10_000,
  }).status === 0;

/** Escape a fully-quoted command for embedding in one double-quoted shell word. */
function doubleQuoted(command: string): string {
  const escaped = command
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
  return `"${escaped}"`;
}

/**
 * The `/bin/sh` pipeline that feeds a pty: `feed` is a shell fragment writing the keystrokes (the
 * chunks plus their timing) to stdout, and `command` is the already-quoted program invocation.
 * Wrapping the feed in a shell is required — `script` needs a pipe, and a spawned child's stdio
 * socketpair fails its `tcgetattr` probe.
 */
export function ptyShellCommand(feed: string, command: string): string {
  if (scriptPath === undefined) throw new Error("no `script` on this machine");
  const script = hasCommandFlag
    ? `'${scriptPath}' -q -e -c ${doubleQuoted(command)} /dev/null`
    : `'${scriptPath}' -q /dev/null ${command}`;
  return `{ ${feed}; } | ${script}`;
}
