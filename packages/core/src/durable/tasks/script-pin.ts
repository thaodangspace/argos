/**
 * FR3 script pinning — the run-level half of the script step.
 *
 * A run pins every script it may execute **before** its task (or worktree) exists: the absolute
 * path resolution found and the sha256 of the bytes at that moment. The pin lives on
 * `RunRecord.scripts`, so it travels with the checkpoint, the mirror, after-task children, and a
 * retry. The `argos.script` task hashes the file again before every spawn and fails the step with
 * `script_changed` when it moved or changed; the engine never retries that.
 *
 * This module is deliberately free of `node:child_process`: it resolves and hashes files only, so
 * `durable/tasks/script.ts` stays the one module that may spawn.
 *
 * Resolution order is the historical one (`SCRIPT_DIRS`, then `<home>/scripts`); the *execution*
 * directory is still the run cwd or worktree, never the home.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ArgosError } from "../../errors.js";
import type { ScriptPinRecord } from "../../engine/index.js";
import type { PlaybookIR } from "../../playbook/ir.js";
import { HOME_SCRIPT_DIR, SCRIPT_DIRS } from "../../playbook/load.js";

export type ScriptPins = Readonly<Record<string, ScriptPinRecord>>;

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Resolve `<name>` to an executable in the repository's script directories, or throw a
 * `step_failed` {@link ArgosError} explaining what was tried. Rejects any path escape.
 * `scriptHome` adds `<home>/scripts` **after** the repository roots; the script still executes in
 * the run cwd or worktree, never in the home.
 */
export function resolveScriptPath(scriptRoot: string, name: string, scriptHome?: string): string {
  const rejected = (reason: string): ArgosError =>
    new ArgosError("step_failed", `script ${JSON.stringify(name)}: ${reason}`);
  if (name === "") throw rejected("the script name is empty");
  if (isAbsolute(name)) throw rejected("an absolute path is not allowed; name a file in .argos/scripts");
  if (name.includes("/") || name.includes("\\")) {
    throw rejected("a path is not allowed; name a file in .argos/scripts");
  }
  if (name === "." || name === "..") throw rejected("path traversal is not allowed");

  const tried: string[] = [];
  const directories = SCRIPT_DIRS.map((directory) => join(scriptRoot, directory));
  if (scriptHome !== undefined) directories.push(join(resolve(scriptHome), HOME_SCRIPT_DIR));
  for (const directory of directories) {
    const candidate = join(directory, name);
    tried.push(candidate);
    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      throw rejected(`${candidate} is not executable`);
    }
    return candidate;
  }
  throw rejected(`not found (looked in ${tried.join(", ")})`);
}

/** The sha256 of a file's bytes, lowercase hex. Throws when the file cannot be read. */
export function hashScript(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Resolve and hash one script — the unit `pinRunScripts` and `ArgosHost.retryStep` share. Errors
 * are the `step_failed` {@link ArgosError}s of {@link resolveScriptPath} (or a read failure).
 */
export function pinScript(
  scriptRoot: string,
  name: string,
  scriptHome?: string,
): ScriptPinRecord {
  const path = resolveScriptPath(scriptRoot, name, scriptHome);
  return { path, sha256: hashScript(path) };
}

/**
 * Pin every script the frozen IR can dispatch — main steps first, then each after-step — keyed by
 * script name (two steps that share a helper share one pin). Returns `undefined` when the playbook
 * has no script step, so a record without scripts keeps hydrating exactly as before (FR3.6).
 *
 * A name that cannot be resolved **or** is not executable is `playbook_invalid` naming the step:
 * the caller (the host) refuses the run before any task or worktree exists (FR3.2).
 */
export function pinRunScripts(
  ir: PlaybookIR,
  scriptRoot: string,
  scriptHome?: string,
): ScriptPins | undefined {
  const steps = [...ir.steps, ...ir.after.flatMap((after) => after.steps)];
  const pins: Record<string, ScriptPinRecord> = {};
  for (const step of steps) {
    const name = step.script?.run;
    if (name === undefined || pins[name] !== undefined) continue;
    let pin: ScriptPinRecord;
    try {
      pin = pinScript(scriptRoot, name, scriptHome);
    } catch (error) {
      throw new ArgosError(
        "playbook_invalid",
        `playbook ${ir.id}: step ${step.id}: ${messageOf(error)}`,
        { stepId: step.id, cause: error },
      );
    }
    pins[name] = pin;
  }
  return Object.keys(pins).length === 0 ? undefined : pins;
}

export type PinCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/**
 * Compare a pin with the file on disk. A deleted file is reported as **missing** (that is what an
 * operator has to know), a different digest as changed. R4: the spawn that follows the check can
 * still race a writer; the pin detects, it does not prevent.
 */
export function checkPin(pin: ScriptPinRecord): PinCheck {
  let current: string;
  try {
    current = hashScript(pin.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        detail: `the pinned script ${pin.path} is missing: it was deleted after the run started`,
      };
    }
    return {
      ok: false,
      detail: `cannot read the pinned script ${pin.path}: ${messageOf(error)}`,
    };
  }
  if (current !== pin.sha256) {
    return {
      ok: false,
      detail: `the pinned script ${pin.path} changed after the run started (pinned ${pin.sha256}, found ${current})`,
    };
  }
  return { ok: true };
}
