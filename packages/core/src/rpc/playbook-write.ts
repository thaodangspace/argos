/**
 * Playbook editor containment (spec FR4, FR5, FR15, FR18): the one place a `file` from the wire
 * becomes a path Argos is willing to read — and, from the save route, to write.
 *
 * The rules are the containment steps of the spec's "Containment and write algorithm", in this
 * order: discovery first (it is the only source of truth for what a playbook *is*), then `realpath`
 * of the request, then string equality with one discovered entry, then an `lstat` re-check, then the
 * text cap and the digest. A path built from an id would accept `../../etc/passwd.yaml`; a path
 * trusted from the request would accept a symlink pointing out of the repository. The id therefore
 * always comes from the matched entry, never from the request.
 *
 * The one write is {@link writePlaybookAtomically}: a temp file in the target's own directory, then
 * a rename over the target, so a reader never sees a half-written playbook. The verdict that must
 * hold *before* that write lives in `playbooks.ts` (it owns the loader's projection), which imports
 * this module — so `writePlaybookFile` sits there and this module stays the free end of that edge.
 *
 * `cwd` is deliberately **not** validated here: `server.ts` calls `validateRunCwd` before this
 * module, which keeps it free of `../durable/*` (and of `server.ts`), so the containment matrix is
 * testable without a host. Nothing here opens storage, spawns, or logs.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { argosError, type ArgosError } from "../errors.js";
import { discoverPlaybooks, type PlaybookEntry } from "../playbook/load.js";
import { PLAYBOOK_TEXT_LIMIT } from "./contracts.js";

/**
 * The only two directories a save may write (FR18). Both are repository roots; `<home>/playbooks`
 * is readable and never writable (FR5).
 */
const WRITABLE_ROOTS: ReadonlySet<string> = new Set([".argos/playbooks", ".paseo/plugins/playbooks"]);

/** `..` as a whole segment, on either separator, so a Windows-style spelling cannot slip through. */
const PARENT_SEGMENT = /^\.\.$/;

/** A resolved, contained playbook: everything a reader or a save needs, and nothing from the wire. */
export interface PlaybookTarget {
  /** The resolved (`realpath`) path; the file the loader reads and a save would replace. */
  readonly file: string;
  /** Absolute repository root discovery ran against (the loader's `repoDir`). */
  readonly repoDir: string;
  /** The playbook id, taken from the discovered entry — never from the request. */
  readonly id: string;
  /**
   * The entry's discovery root: the repo-relative directory (`.argos/playbooks`,
   * `.paseo/plugins/playbooks`) or the absolute home root.
   */
  readonly root: string;
  /**
   * Where the file came from, and therefore whether a save may replace it: `repo` is one of the two
   * writable repository roots **and** the resolved file is inside the repository; `home` is
   * `<home>/playbooks`, and so is any root whose file resolves outside the repository — read-only.
   * `writable` is exactly `mode === "repo"`, so the two fields are one decision stated twice — a
   * caller checks `writable` and a message can say "home".
   */
  readonly mode: "repo" | "home";
  readonly writable: boolean;
  /** sha256 of the bytes currently on disk (lowercase hex), for a save's precondition. */
  readonly sha256: string;
}

/** Every refusal in this module is a stable `invalid_request`; the message never carries content. */
function refuse(detail: string): never {
  throw argosError("invalid_request", {}, detail);
}

/** The one wording of the text cap (FR15), so read, validate, and save cannot drift. */
export function playbookTextLimitDetail(): string {
  return `playbook text exceeds the ${PLAYBOOK_TEXT_LIMIT} byte limit`;
}

/** True when the text is within {@link PLAYBOOK_TEXT_LIMIT} UTF-8 bytes; refuses otherwise (FR15). */
export function assertPlaybookTextWithinLimit(text: string): void {
  if (Buffer.byteLength(text, "utf8") > PLAYBOOK_TEXT_LIMIT) refuse(playbookTextLimitDetail());
}

/** `realpath`, or `undefined` when the path does not exist (a listing entry can be a dead link). */
function realpathOf(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** The one `409 deleted` a save answers when its file is gone, so code, message, and detail agree. */
function deletedConflict(file: string): ArgosError {
  return argosError(
    "playbook_conflict",
    { file },
    "playbook file no longer exists",
    undefined,
    { reason: "deleted" },
  );
}

/**
 * The one answer for a playbook that is not there: a read refuses it as `invalid_request`, a save as
 * `409 deleted` (editor FR10). Both the missing `realpath` and a file that disappears before the
 * `lstat` come through here, so the codes and the wording cannot drift apart.
 */
function refuseMissing(file: string, whenMissing: "invalid_request" | "deleted" | undefined): never {
  if (whenMissing === "deleted") throw deletedConflict(file);
  refuse("playbook file is not readable");
}

/** `true` for a filesystem `ENOENT`, the only stat failure a vanished playbook is allowed to cause. */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * One read under the cap. The stat is the cheap refusal (an oversized file is never loaded into
 * memory) and the byte length of the actual read is the honest one (the file can grow in between).
 *
 * A file that is gone answers what the caller's `whenMissing` says — the same `409 deleted` a save
 * gives everywhere else — so a vanish between the resolver's `lstat` and this read cannot surface as
 * a `400` (or, worse, an unhandled `ENOENT`) in the middle of a save.
 */
function readCapped(
  file: string,
  whenMissing?: "invalid_request" | "deleted",
): Buffer {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    if (isEnoent(error)) refuseMissing(file, whenMissing);
    refuse("playbook file is not readable");
  }
  if (size > PLAYBOOK_TEXT_LIMIT) refuse(playbookTextLimitDetail());
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (isEnoent(error)) refuseMissing(file, whenMissing);
    refuse("playbook file is not readable");
  }
  if (bytes.byteLength > PLAYBOOK_TEXT_LIMIT) refuse(playbookTextLimitDetail());
  return bytes;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Containment (FR4/FR5/FR15): turn a request `file` into a {@link PlaybookTarget}, or refuse it.
 *
 * Steps, in the spec's order: the cheap shape refusals (NUL, relative, `..`), then
 * `discoverPlaybooks(cwd, home)` as the only source of truth, then `realpathSync(file)` matched
 * against exactly one entry's realpath, then the entry's root decides writability — only when the
 * resolved file is inside the repository — then an `lstat` re-check (a regular file, never a
 * symlink), then the cap and the digest.
 *
 * `..` is refused on the raw spelling on purpose: `…/playbooks/../playbooks/x.yaml` collapses onto a
 * discovered file, and a path that wanders is not one discovery produced, so it is never accepted.
 */
export function resolvePlaybookTarget(input: {
  readonly cwd: string;
  readonly file: string;
  readonly home?: string;
  /**
   * What a request path that no longer exists answers (editor FR10). A read refuses it as
   * `invalid_request` (a listing entry can be a dead link); a save answers `playbook_conflict`
   * with `reason: "deleted"`, because the operator's buffer was edited from a file that is gone.
   * The shape refusals above (NUL, relative, `..`) stay `invalid_request` either way: a path that
   * wanders was never produced by discovery, so it is not a deleted playbook.
   */
  readonly whenMissing?: "invalid_request" | "deleted";
}): PlaybookTarget {
  const repoDir = resolve(input.cwd);
  const requested = input.file;
  if (requested.includes("\u0000")) refuse("file must not contain a NUL byte");
  if (!isAbsolute(requested)) refuse("file must be an absolute path");
  if (requested.split(/[/\\]/).some((segment) => PARENT_SEGMENT.test(segment))) {
    refuse('file must not contain a ".." segment');
  }

  const listing = discoverPlaybooks(repoDir, input.home);
  const resolved = realpathOf(requested);
  if (resolved === undefined) refuseMissing(requested, input.whenMissing);
  const matches = listing.filter((candidate) => realpathOf(candidate.file) === resolved);
  const entry: PlaybookEntry | undefined = matches.length === 1 ? matches[0] : undefined;
  if (entry === undefined) refuse("file is not a discovered playbook of this repository");

  // (6) TOCTOU re-check. `resolved` already lost its final symlink, so the requested spelling is
  // what tells a link from the file it points at — and a link is refused even when it lands on a
  // discovered playbook, because the operator's file is the one discovery listed, not the alias.
  let requestedStat;
  try {
    requestedStat = lstatSync(requested);
  } catch {
    refuse("playbook file is not readable");
  }
  if (requestedStat.isSymbolicLink()) refuse("file must not be a symlink");
  if (!requestedStat.isFile()) refuse("file must be a regular file");
  // The file can be gone by now (a listing entry, then a delete): the same answer as a missing
  // `realpath`, never an `ENOENT` escaping as a 500.
  let targetStat;
  try {
    targetStat = lstatSync(resolved);
  } catch (error) {
    if (isEnoent(error)) refuseMissing(resolved, input.whenMissing);
    refuse("playbook file is not readable");
  }
  if (!targetStat.isFile()) refuse("file must be a regular file");

  // (5) The matched root decides writability: one of the two repository roots, **and** the resolved
  // file really inside the repository. `entry.root` is only the root's label, so a symlinked
  // `.argos/playbooks` (or a symlinked `.argos`) would otherwise be "repo" while pointing anywhere.
  // A root that fails either half is read-only, which `home` means: the safe default.
  const repoReal = realpathOf(repoDir) ?? repoDir;
  const repoPrefix = repoReal.endsWith(sep) ? repoReal : `${repoReal}${sep}`;
  const insideRepo = resolved.startsWith(repoPrefix);
  const mode: PlaybookTarget["mode"] =
    !isAbsolute(entry.root) && WRITABLE_ROOTS.has(entry.root) && insideRepo ? "repo" : "home";

  const sha256 = digestOf(readCapped(resolved, input.whenMissing));
  return {
    file: resolved,
    repoDir,
    id: entry.id,
    root: entry.root,
    mode,
    writable: mode === "repo",
    sha256,
  };
}

/**
 * The text and the digest of **the same** bytes, from one read.
 *
 * Reading twice would let a client chain a `sha256` that does not belong to the text it was shown
 * (and a save would then overwrite text the operator never saw). The cap and the readability refusal
 * are re-checked here because the file can change between the resolver and this read.
 */
export function readPlaybookSource(
  target: PlaybookTarget,
  whenMissing?: "invalid_request" | "deleted",
): {
  readonly yaml: string;
  readonly sha256: string;
} {
  const bytes = readCapped(target.file, whenMissing);
  return { yaml: bytes.toString("utf8"), sha256: digestOf(bytes) };
}

/**
 * The mode to keep. A file that vanished between the resolver's digest and this call is a `409
 * deleted` (the same answer the resolver gives), never an `ENOENT` escaping as a 500; any other
 * stat failure is a real I/O error and stays one.
 */
function modeOf(file: string): number {
  try {
    return statSync(file).mode & 0o777;
  } catch (error) {
    if (isEnoent(error)) throw deletedConflict(file);
    throw error;
  }
}

/** The result of one atomic write: what is on disk now, and the mode the file kept (FR12/FR13). */
export interface WrittenPlaybook {
  readonly sha256: string;
  readonly mode: number;
}

/**
 * Replace a playbook's bytes atomically (FR12), keeping the mode it had.
 *
 * The temp file is a sibling — same directory, same filesystem — so the rename is atomic and a
 * reader sees either the old playbook or the new one, never half of either; a temp under `/tmp`
 * could cross devices and degrade to a copy. The temp name carries 8 random bytes so two saves of
 * the same file cannot collide. Any failure removes the temp file and rethrows: a refused save
 * leaves no debris behind. `rename` replaces a symlink rather than following it, which is why the
 * containment's `lstat` refusal and this call agree about what the target is.
 *
 * `writeFileSync`'s `mode` is masked by the process umask, so the explicit `chmod` is what keeps a
 * `0740` playbook `0740` under a stricter umask.
 */
export function writePlaybookAtomically(target: PlaybookTarget, text: string): WrittenPlaybook {
  const mode = modeOf(target.file);
  const temp = `${target.file}.argos-tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target.file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ENOENT: the write never created it, or the rename already moved it away.
    }
    throw error;
  }
  return { sha256: digestOf(Buffer.from(text, "utf8")), mode };
}
