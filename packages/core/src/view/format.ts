/**
 * Pure formatting for the panel (no React, no theme, no `Date.now()`): the tests pin every label.
 *
 * Keeping this out of the client entry means the CI-style rows and the step log are snapshot
 * testable, and the strings stay locale-independent (`en-CA` parts, never `toLocaleString`), which
 * matters because a pane may render on a different host than the daemon.
 *
 * Every timestamp takes an optional IANA `timeZone`; `undefined` means **the runtime's own zone**
 * (the browser's, or the daemon's `TZ`). A client that rendered UTC for a reader eight hours east
 * would be showing a wrong clock, so UTC is a choice, not the default. The parts are built from
 * `Intl.DateTimeFormat.formatToParts`, so two clients in two zones differ only in the value, never
 * in the shape: `2026-11-14 22:15 UTC` / `2026-11-15 05:15 +07:00`.
 */

/** `840` -> "840ms", `62_000` -> "1m 2s", `3_600_000` -> "1h 0m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** One instant projected onto a zone: the pieces every label below is built from. */
interface ZonedInstant {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:MM:SS`, 00–23. */
  readonly time: string;
  /** `UTC`, or the offset the zone was at that instant (`+07:00`, `-04:00` — a DST-dependent value). */
  readonly offset: string;
}

/** One formatter per zone: `Intl` construction is the expensive half, and a list row formats twice. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function buildFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
}

/**
 * The formatter for a zone (cached). `undefined` is the runtime's zone, and an id this runtime does
 * not know falls back to it as well: a stale `localStorage` entry must never break a render.
 */
function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = key === "" ? buildFormatter(undefined) : buildFormatter(key);
  } catch {
    created = formatters.get("") ?? buildFormatter(undefined);
  }
  formatters.set(key, created);
  return created;
}

/** `GMT+07:00` (what V8 reports) -> `+07:00`; a zero offset is spelled `UTC` on every runtime. */
function offsetLabel(raw: string): string {
  if (raw === "UTC" || raw === "GMT" || raw === "GMT+00:00" || raw === "GMT-00:00") return "UTC";
  return raw.startsWith("GMT") ? raw.slice(3) : raw;
}

function zoned(at: number, timeZone: string | undefined): ZonedInstant {
  const parts = formatterFor(timeZone).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}:${pick("second")}`,
    offset: offsetLabel(pick("timeZoneName")),
  };
}

/** The zone this runtime renders in by default: the browser's, or the daemon's `TZ`. */
export function systemTimeZone(): string {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === undefined || zone === "" ? "UTC" : zone;
}

/** True when `zone` is an IANA id this runtime knows, so a stored preference can be vetted. */
export function isTimeZone(zone: string): boolean {
  if (zone.trim() === "") return false;
  try {
    buildFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The inventory a timezone picker offers (`UTC` first, then every id the runtime knows). An engine
 * without `Intl.supportedValuesOf` still gets `UTC` plus its own zone, so the picker is never empty.
 */
export function listTimeZones(): readonly string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = new Set<string>(["UTC", ...supported]);
  return [...zones];
}

/** `HH:MM:SS` in the zone — the column the step log prints next to every line. */
export function formatClock(at: number | null, timeZone?: string): string {
  if (at === null || !Number.isFinite(at)) return "";
  return zoned(at, timeZone).time;
}

/** `YYYY-MM-DD HH:MM` plus the zone's offset at that instant (`2026-11-15 05:15 +07:00`). */
export function formatDateTime(at: number, timeZone?: string): string {
  const parts = zoned(at, timeZone);
  return `${parts.date} ${parts.time.slice(0, 5)} ${parts.offset}`;
}

/** `YYYY-MM-DD` in the zone: the day key the list's sections are cut by. */
export function formatDate(at: number, timeZone?: string): string {
  return zoned(at, timeZone).date;
}

/** "just now" / "3m ago" / "2h ago" / "3d ago" / "2026-11-01", against an injected `now`. */
export function formatRelative(at: number, now: number, timeZone?: string): string {
  const diff = now - at;
  if (!Number.isFinite(diff)) return "";
  if (diff < -60_000) return `in ${formatDuration(-diff)}`;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.max(1, Math.round(diff / 86_400_000))}d ago`;
  return formatDate(at, timeZone);
}

/** The GitHub-CI-style short id: `01M798D7…` -> `01M798D7`. */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}

/** `6_322_750` -> "6.32M"; `35_982` -> "35.9k"; `130` -> "130". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1_000) return `${Math.round(value)}`;
  if (abs < 1_000_000) return `${trimZero((value / 1_000).toFixed(1))}k`;
  if (abs < 1_000_000_000) return `${trimZero((value / 1_000_000).toFixed(2))}M`;
  return `${trimZero((value / 1_000_000_000).toFixed(2))}B`;
}

function trimZero(text: string): string {
  return text.replace(/\.?0+$/, "");
}

/** `3.017` -> "$3.02"; `0.0042` -> "$0.0042"; `0` -> "$0". */
export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Provider usage as one CI-log line: `$3.02 · 130 in · 35.9k out · 6.32M cached`. Unknown keys are
 * kept as `key=value` so a new counter is visible without a code change. `null` when it is empty.
 */
export function formatUsage(usage: Readonly<Record<string, number>> | undefined): string | null {
  if (usage === undefined) return null;
  const parts: string[] = [];
  const cost = usage["totalCostUsd"];
  if (cost !== undefined) parts.push(formatCostUsd(cost));
  const input = usage["inputTokens"];
  const output = usage["outputTokens"];
  const cached = usage["cachedInputTokens"];
  if (input !== undefined) parts.push(`${formatTokens(input)} in`);
  if (output !== undefined) parts.push(`${formatTokens(output)} out`);
  if (cached !== undefined) parts.push(`${formatTokens(cached)} cached`);
  const context = usage["contextWindowUsedTokens"];
  const contextMax = usage["contextWindowMaxTokens"];
  if (context !== undefined && contextMax !== undefined) {
    parts.push(`ctx ${formatTokens(context)}/${formatTokens(contextMax)}`);
  }
  const known = new Set([
    "totalCostUsd",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "contextWindowUsedTokens",
    "contextWindowMaxTokens",
  ]);
  for (const [name, value] of Object.entries(usage)) {
    if (known.has(name)) continue;
    parts.push(`${name}=${formatTokens(value)}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A scalar as a log line (strings keep their newlines; the renderer splits them). */
export function formatScalar(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

export function pluralized(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
