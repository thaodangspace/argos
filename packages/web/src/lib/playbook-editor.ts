/**
 * The editor's pure model (editor FR22–FR25): dirty detection, save eligibility, the issue list, the
 * conflict text, and the caret line an issue points at.
 *
 * No DOM, no fetch: the component renders markup and the tests assert it, so the decisions an
 * operator can argue with (is Save on? in what order are the issues?) live here and are tested
 * without jsdom. Everything imports from `rpc/contracts` only, so the guard's import graph holds.
 */

import {
  PLAYBOOK_ISSUE_LIMIT,
  type PlaybookIssue,
  type PlaybookLoadError,
} from "@thaodangspace/argos-core/rpc/contracts";

/** How long typing settles before one `POST /playbooks/validate` (editor FR22). */
export const DEBOUNCE_MS = 400;

/** The two repository roots a save may write; `<home>/playbooks` is readable only (editor FR5). */
const WRITABLE_ROOTS: readonly string[] = [".argos/playbooks", ".paseo/plugins/playbooks"];

/** A dirty buffer is the buffer and the loaded text disagreeing, byte for byte. */
export function isDirty(text: string, loaded: string): boolean {
  return text !== loaded;
}

/** Why Save is unavailable, so the surface can say it instead of only disabling a button. */
export type SaveBlockReason = "clean" | "invalid" | "read-only";

export interface SaveEligibility {
  readonly canSave: boolean;
  readonly reason: SaveBlockReason | null;
  readonly hint: string;
}

/**
 * Save is on only when the buffer is dirty **and** the last verdict is valid **and** the file is
 * writable (editor FR23/FR18). Read-only is checked first: an operator on a home playbook must not
 * be told to edit before being told there is nowhere to save it.
 */
export function saveEligibility(input: {
  readonly dirty: boolean;
  readonly valid: boolean;
  readonly writable: boolean;
}): SaveEligibility {
  if (!input.writable) {
    return {
      canSave: false,
      reason: "read-only",
      hint: "A home playbook is read-only; only a repository .argos/playbooks or .paseo/plugins/playbooks file can be saved.",
    };
  }
  if (!input.dirty) {
    return { canSave: false, reason: "clean", hint: "No unsaved changes." };
  }
  if (!input.valid) {
    return {
      canSave: false,
      reason: "invalid",
      hint: "Fix the issues before saving; the loader refuses an invalid buffer.",
    };
  }
  return { canSave: true, reason: null, hint: "Save the buffer to disk (⌘/Ctrl+S)." };
}

/**
 * Whether a save could write this file, mirroring the server's two roots (editor FR18): the server
 * still enforces it, and the editor only decides whether to render the button. A path outside the
 * scope — a home playbook, a sibling repository — reads as read-only, which is the safe default.
 */
export function isWritablePlaybook(cwd: string, file: string): boolean {
  const root = normalizePath(cwd);
  if (root === "") return false;
  const target = normalizePath(file);
  const prefix = root === "/" ? "" : root;
  return WRITABLE_ROOTS.some((relative) => target.startsWith(`${prefix}/${relative}/`));
}

/** Forward slashes, no trailing separator, and the filesystem root kept as `/`. */
function normalizePath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/**
 * Every issue a verdict carries, one list (editor FR22). An `errors[]` entry with no `issues[]` (a
 * graph-check failure, or a server too old to project them) still produces one readable row, so the
 * panel never says "0 issues" beside a failed verdict.
 */
export function verdictIssues(errors: readonly PlaybookLoadError[]): PlaybookIssue[] {
  return errors.flatMap((error) =>
    error.issues === undefined || error.issues.length === 0
      ? [{ path: "(root)", message: `${error.code}: ${error.message}` }]
      : error.issues,
  );
}

function compareText(left: string, right: string): number {
  // Deliberately not `localeCompare`: the order of a stable list must not depend on the runtime locale.
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Step first, then the path inside the document, then the message (editor FR22). A file-level issue
 * (`stepId` absent) sorts before every step, because "the playbook has a typo at the top level" is
 * the first thing to read.
 */
export function orderIssues(issues: readonly PlaybookIssue[]): PlaybookIssue[] {
  return [...issues].sort(
    (left, right) =>
      compareText(left.stepId ?? "", right.stepId ?? "") ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
}

/**
 * The server caps its own list (FR8), so this cap is a second belt: a panel never grows past
 * {@link PLAYBOOK_ISSUE_LIMIT} rows, and the count it hides is reported instead of silently dropped.
 */
export function boundedIssues(
  issues: readonly PlaybookIssue[],
  limit: number = PLAYBOOK_ISSUE_LIMIT,
): { readonly issues: PlaybookIssue[]; readonly hidden: number } {
  const bounded = Math.max(0, Math.trunc(limit));
  return {
    issues: issues.slice(0, bounded),
    hidden: Math.max(0, issues.length - bounded),
  };
}

/** The panel's whole content in one call: flatten, order, then cap. */
export function issueList(
  errors: readonly PlaybookLoadError[],
  limit: number = PLAYBOOK_ISSUE_LIMIT,
): { readonly issues: PlaybookIssue[]; readonly hidden: number } {
  return boundedIssues(orderIssues(verdictIssues(errors)), limit);
}

const CONFLICT_TEXT: Readonly<Record<string, string>> = {
  changed:
    "This playbook changed on disk since you loaded it. Reload to see the new text, or overwrite it with your buffer.",
  deleted:
    "This playbook was deleted since you loaded it. Reload cannot find it; copy your buffer elsewhere before leaving.",
};

/**
 * The conflict panel's sentence (editor FR25). An unknown reason still reads as a conflict, never as
 * a generic failure: the file on disk is the one thing the operator has to look at.
 */
export function conflictText(reason: string | undefined): string {
  if (reason === undefined) {
    return "This playbook cannot be saved because the file on disk no longer matches what you loaded. Reload and try again.";
  }
  return (
    CONFLICT_TEXT[reason] ??
    "This playbook cannot be saved because the file on disk no longer matches what you loaded. Reload and try again."
  );
}

function plainKey(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The key segments of an issue path: `steps.0.on.complete` → `steps`, `on`, `complete`. */
function pathKeys(path: string): string[] {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "(root)" && !/^\d+$/.test(part));
}

/**
 * The 1-based line an issue path points at, or `undefined` when the path has no line Argos can find
 * (editor FR22): the deepest key of the path that appears as `key:` somewhere in the text. Best
 * effort by design — the loader's path is a document path, not an offset — and the panel only
 * highlights the row when there is nothing to jump to.
 */
export function lineForIssue(path: string, text: string): number | undefined {
  if (path === "" || path === "(root)") return text === "" ? undefined : 1;
  const lines = text.split("\n");
  const keys = pathKeys(path);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (key === undefined) continue;
    const pattern = new RegExp(`^\\s*(?:-\\s+)?${plainKey(key)}\\s*:`);
    const found = lines.findIndex((line) => pattern.test(line));
    if (found !== -1) return found + 1;
  }
  return undefined;
}

/** The character offset of a 1-based line, clamped into the text (for `setSelectionRange`). */
export function offsetForLine(text: string, line: number): number {
  const lines = text.split("\n");
  const target = Math.max(1, Math.min(Math.trunc(line), lines.length));
  let offset = 0;
  for (let index = 0; index < target - 1; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return Math.min(offset, text.length);
}
