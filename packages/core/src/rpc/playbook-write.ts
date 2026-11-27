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
import { isAbsolute, resolve } from "node:path";

import { argosError } from "../errors.js";
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
   * writable repository roots, `home` is `<home>/playbooks` (read-only). `writable` is exactly
   * `mode === "repo"`, so the two fields are one decision stated twice — a caller checks `writable`
   * and a message can say "home".
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

/**
 * One read under the cap. The stat is the cheap refusal (an oversized file is never loaded into
 * memory) and the byte length of the actual read is the honest one (the file can grow in between).
 */
function readCapped(file: string): Buffer {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    refuse("playbook file is not readable");
  }
  if (size > PLAYBOOK_TEXT_LIMIT) refuse(playbookTextLimitDetail());
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
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
 * against exactly one entry's realpath, then the entry's root decides writability, then an `lstat`
 * re-check (a regular file, never a symlink), then the cap and the digest.
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
  if (resolved === undefined) {
    if (input.whenMissing === "deleted") {
      throw argosError(
        "playbook_conflict",
        { file: requested },
        "playbook file no longer exists",
        undefined,
        { reason: "deleted" },
      );
    }
    refuse("file is not a discovered playbook of this repository");
  }
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
  const targetStat = lstatSync(resolved);
  if (!targetStat.isFile()) refuse("file must be a regular file");

  // (5) The matched root decides writability. A root that is neither of the two repository roots is
  // read-only, which `home` means: the safe default for anything new.
  const mode: PlaybookTarget["mode"] =
    !isAbsolute(entry.root) && WRITABLE_ROOTS.has(entry.root) ? "repo" : "home";

  const sha256 = digestOf(readCapped(resolved));
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
export function readPlaybookSource(target: PlaybookTarget): {
  readonly yaml: string;
  readonly sha256: string;
} {
  const bytes = readCapped(target.file);
  return { yaml: bytes.toString("utf8"), sha256: digestOf(bytes) };
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
  const mode = statSync(target.file).mode & 0o777;
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
