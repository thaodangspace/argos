/**
 * Workflows hidden from the scope rail, remembered in `localStorage`.
 *
 * This is a **per-browser view preference**, not server state: `argos` never learns that a workflow
 * was hidden, no run is touched, and a scheduled workflow keeps firing. That is deliberate — hiding
 * is the cheap answer to "I have eleven workflows and four are one-off experiments", while an
 * *archived* workflow would be a control-plane fact (refuse starts, pause the schedule) and belongs
 * in a document, not in a browser. Pure so the parse/toggle rules are testable.
 */

export const HIDDEN_WORKFLOWS_KEY = "argos.hiddenWorkflows";

/** The storage surface this module needs, so a test can pass a stub. */
export interface HiddenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Tolerant read: anything unparseable means "nothing hidden", never a broken rail. */
export function readHidden(storage: HiddenStorage | undefined): string[] {
  if (storage === undefined) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(HIDDEN_WORKFLOWS_KEY);
  } catch {
    return [];
  }
  if (raw === null || raw === "") return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

export function writeHidden(storage: HiddenStorage | undefined, ids: readonly string[]): void {
  if (storage === undefined) return;
  try {
    storage.setItem(HIDDEN_WORKFLOWS_KEY, JSON.stringify([...new Set(ids)].sort()));
  } catch {
    // A full or blocked storage must never break the list: the hide simply does not persist.
  }
}

export function toggleHidden(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id].sort();
}

export function isHidden(ids: readonly string[], id: string): boolean {
  return ids.includes(id);
}

/** The `localStorage` of this browser, or `undefined` when it is absent or blocked. */
export function browserStorage(): HiddenStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
