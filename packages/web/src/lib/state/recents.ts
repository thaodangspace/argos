/**
 * Recently used `cwd` values for the start dialog (spec FR13), persisted locally only.
 */

export const RECENTS_KEY = "argos:ui:recents";
export const RECENTS_LIMIT = 8;

/** Newest first, no duplicates, trimmed, bounded. An empty value is ignored. */
export function addRecent(
  recents: readonly string[],
  cwd: string,
  limit = RECENTS_LIMIT,
): string[] {
  const value = cwd.trim();
  if (value === "") return [...recents];
  return [value, ...recents.filter((entry) => entry !== value)].slice(0, limit);
}

export function readRecents(storage?: Pick<Storage, "getItem"> | null): string[] {
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (target === null) return [];
  try {
    const parsed: unknown = JSON.parse(target.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecents(
  recents: readonly string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const target = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  if (target === null) return;
  target.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, RECENTS_LIMIT)));
}
