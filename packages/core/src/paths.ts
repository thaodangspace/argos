import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory mode for `$ARGOS_HOME` and its private contents (FR4). */
export const ARGOS_HOME_MODE = 0o700;

/** Token file mode for `$ARGOS_HOME/token` (FR27). */
export const ARGOS_TOKEN_MODE = 0o600;

/** `$ARGOS_HOME`, defaulting to `~/.argos` (D1). */
export function argosHome(): string {
  const override = process.env["ARGOS_HOME"];
  return override !== undefined && override.trim() !== ""
    ? override
    : join(homedir(), ".argos");
}

/** Path of the single-writer SQLite database (D1). */
export function dbPath(home: string = argosHome()): string {
  return join(home, "argos.sqlite");
}

/** Path of the RPC bearer token file (D1, FR27). */
export function tokenPath(home: string = argosHome()): string {
  return join(home, "token");
}

/** Path of the `argos serve` pid file (D1). */
export function pidPath(home: string = argosHome()): string {
  return join(home, "serve.pid");
}

/**
 * Create `$ARGOS_HOME` with `0700`, repairing the mode when it already exists.
 * Returns the resolved home directory.
 */
export function ensureHome(home: string = argosHome()): string {
  mkdirSync(home, { recursive: true, mode: ARGOS_HOME_MODE });
  chmodSync(home, ARGOS_HOME_MODE);
  return home;
}
