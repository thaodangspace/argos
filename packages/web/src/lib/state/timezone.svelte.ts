/**
 * The zone every timestamp is rendered in.
 *
 * The default is **the browser's own zone**: a reader eight hours east of Greenwich should see
 * 08:00, not 00:00 UTC. An explicit choice is remembered in `localStorage` like the theme, and it is
 * per browser — `argos` never learns it, and it changes no data. That is why it is *not* part of the
 * URL's list state: the URL holds the scope (which runs), this holds the rendering (what clock).
 *
 * Pure helpers first so the parse/fallback rules are testable without a DOM.
 */

import {
  isTimeZone,
  listTimeZones,
  systemTimeZone,
} from "@thaodangspace/argos-core/view";

export const TIMEZONE_STORAGE_KEY = "argos.ui.timezone";

/** The storage surface the store needs, so a test can pass a stub. */
export interface ZoneStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A stored preference as a zone id: `undefined` (follow the browser) for an empty, unknown, or
 * unreadable value. A hand-edited `localStorage` entry must never break a render.
 */
export function resolveTimeZone(stored: string | null): string | undefined {
  if (stored === null) return undefined;
  const zone = stored.trim();
  if (zone === "") return undefined;
  return isTimeZone(zone) ? zone : undefined;
}

/**
 * The picker's options: `UTC` and every id this runtime knows, minus the browser's own zone (which
 * the picker offers as its "Local" entry, so the same zone cannot appear twice).
 */
export function timeZoneChoices(system: string): readonly string[] {
  return listTimeZones().filter((zone) => zone !== system);
}

export class TimeZoneStore {
  /** What the runtime reports for itself: the "Local" entry of the picker. */
  system = $state<string>("UTC");
  /** The reader's choice; `undefined` follows the browser. */
  timeZone = $state<string | undefined>(undefined);
  /** The picker's non-local options, resolved once (418 ids in a current ICU). */
  choices: readonly string[] = [];

  /** Read the runtime zone and the stored choice. Idempotent: the layout calls it once on mount. */
  init(storage?: ZoneStorage): void {
    this.system = systemTimeZone();
    this.choices = timeZoneChoices(this.system);
    let stored: string | null = null;
    try {
      stored = storage?.getItem(TIMEZONE_STORAGE_KEY) ?? null;
    } catch {
      stored = null;
    }
    this.timeZone = resolveTimeZone(stored);
  }

  /** Choose a zone (`""` = follow the browser) and remember it for this browser. */
  select(zone: string | undefined, storage?: ZoneStorage): void {
    const next = resolveTimeZone(zone ?? "");
    this.timeZone = next;
    try {
      storage?.setItem(TIMEZONE_STORAGE_KEY, next ?? "");
    } catch {
      // A full or blocked storage must never break a render: the choice simply does not persist.
    }
  }
}

/** One store per browser session: the layout renders the picker, both pages read the zone. */
export const timeZoneStore = new TimeZoneStore();
