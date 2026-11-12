/**
 * `$ARGOS_HOME` ownership and database permissions (FR5.2 split of `host.ts`, FR4).
 *
 * The single-writer rule is a pid file: a live owner refuses the open with `storage_locked`, a
 * stale file left by a dead process is replaced, and the file is only removed by the process it
 * names. `enforceStorageModes` keeps the SQLite file (and its WAL sidecars) private to the user.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { ArgosError } from "../errors.js";
import { dbPath, ensureHome, pidPath } from "../paths.js";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: alive but owned by another user; still a live writer.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(home: string): number | undefined {
  try {
    const raw = readFileSync(pidPath(home), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Take the single-writer pid file. A live owner refuses the open with `storage_locked`; a stale
 * file (dead process, unreadable content) is replaced.
 */
export function acquirePidFile(home: string): void {
  ensureHome(home);
  const file = pidPath(home);
  const owner = readPid(home);
  if (owner !== undefined && owner !== process.pid && processIsAlive(owner)) {
    throw new ArgosError(
      "storage_locked",
      `${file}: another argos process (pid ${owner}) owns this home; stop it first`,
    );
  }
  if (owner === process.pid) {
    throw new ArgosError(
      "storage_locked",
      `${file}: this process already owns this home (pid ${owner}); close the other ArgosHost`,
    );
  }
  writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
}

/** Remove the pid file only when it still names this process. */
export function releasePidFile(home: string): void {
  if (readPid(home) !== process.pid) return;
  rmSync(pidPath(home), { force: true });
}

/** FR4: the database file is private to the user. */
export function enforceStorageModes(home: string): void {
  const file = dbPath(home);
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
