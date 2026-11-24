/**
 * The fs half of the installer (spec NFR "Atomic writes"; plan Phase 2).
 *
 * `plan.ts` decided *what* to write; this module only performs it:
 *
 * - every file is written to a sibling temp file, `chmod`ed, then `rename`d, so a reader never sees
 *   half a template;
 * - the manifest is written **last**, so an interrupted install leaves a detectable gap;
 * - a pack's program directory is `0700`, and a `--link`ed program is a symlink instead of a copy;
 * - `--prune` removes a `<name>@<version>/` directory only when the plan named it, and only when it
 *   is a direct child of `$ARGOS_HOME/hc/packs` whose name matches `<pack>@<version>`.
 *
 * Every path is re-checked against the two resolved directories before it is touched: the plan is
 * pure and tested, but a bug in it must not become a write outside `$ARGOS_HOME` or the templates
 * directory.
 */

import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import type { InstallPlan, UninstallPlan } from "./plan.js";
import { PACK_DIR_RULE, manifestPath, packsRoot } from "./templates-dir.js";

/** A path the installer refused to touch (a bug, or a hand-edited plan — never a user error). */
export class PackApplyError extends Error {
  override readonly name = "PackApplyError";
}

export interface ApplyContext {
  readonly home: string;
  readonly templatesDir: string;
}

export interface ApplyResult {
  readonly written: readonly string[];
  readonly linked: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: boolean;
}

function inside(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(`${base}${sep}`);
}

function guard(ok: boolean, path: string): void {
  if (!ok) {
    throw new PackApplyError(`refusing to touch ${path}: outside the argos pack directories`);
  }
}

/** A pack directory is `<packsRoot>/<pack>@<version>` and nothing else. */
function assertPackDir(path: string, home: string): void {
  const root = resolve(packsRoot(home));
  const target = resolve(path);
  guard(dirname(target) === root && PACK_DIR_RULE.test(basename(target)), path);
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.argos-tmp-${process.pid}`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function linkAtomic(path: string, target: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The destination is inside a directory Argos owns: replacing an older copy (or a stale link) is
  // exactly what `--link` means.
  rmSync(path, { force: true });
  symlinkSync(target, path, "file");
}

/** Apply an install plan: programs and templates, then the manifest. */
export function applyInstall(plan: InstallPlan, context: ApplyContext): ApplyResult {
  const packs = packsRoot(context.home);
  const manifest = manifestPath(context.home);
  for (const write of plan.writes) {
    guard(
      inside(context.templatesDir, write.path) ||
        inside(packs, write.path) ||
        resolve(write.path) === resolve(manifest),
      write.path,
    );
  }
  for (const link of plan.links) guard(inside(packs, link.path), link.path);

  const written: string[] = [];
  for (const write of plan.writes) {
    writeAtomic(write.path, write.content, write.mode);
    if (inside(packs, write.path)) chmodSync(dirname(write.path), 0o700);
    written.push(write.path);
  }
  const linked: string[] = [];
  for (const link of plan.links) {
    linkAtomic(link.path, link.target);
    chmodSync(dirname(link.path), 0o700);
    linked.push(link.path);
  }
  if (plan.manifestWrite !== undefined) {
    writeAtomic(plan.manifestWrite.path, plan.manifestWrite.content, plan.manifestWrite.mode);
    written.push(plan.manifestWrite.path);
  }
  return { written, linked, removed: [], unchanged: plan.unchanged };
}

/** Apply an uninstall plan: marker files and pruned pack directories, then the manifest. */
export function applyUninstall(plan: UninstallPlan, context: ApplyContext): ApplyResult {
  for (const remove of plan.removes) {
    if (remove.kind === "pack") assertPackDir(remove.path, context.home);
    else guard(inside(context.templatesDir, remove.path), remove.path);
  }
  const removed: string[] = [];
  for (const remove of plan.removes) {
    rmSync(remove.path, remove.kind === "pack" ? { recursive: true, force: true } : { force: true });
    removed.push(remove.path);
  }
  if (plan.manifestWrite !== undefined) {
    writeAtomic(plan.manifestWrite.path, plan.manifestWrite.content, plan.manifestWrite.mode);
  }
  return { written: [], linked: [], removed, unchanged: plan.unchanged };
}
