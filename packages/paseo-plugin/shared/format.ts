/**
 * Pure formatting for the panel (no React, no theme, no `Date.now()`): the tests pin every label.
 *
 * Keeping this out of the client entry means the CI-style rows and the step log are snapshot
 * testable, and the strings stay locale-independent (ISO slices, no `Intl`), which matters because
 * a pane may render on a different host than the daemon.
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

/** `HH:MM:SS` (UTC) — the column the step log prints next to every line. */
export function formatClock(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "";
  return new Date(at).toISOString().slice(11, 19);
}

/** `YYYY-MM-DD HH:MM UTC`. */
export function formatDateTime(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "just now" / "3m ago" / "2h ago" / "3d ago" / "2026-11-01", against an injected `now`. */
export function formatRelative(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff)) return "";
  if (diff < -60_000) return `in ${formatDuration(-diff)}`;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.max(1, Math.round(diff / 86_400_000))}d ago`;
  return new Date(at).toISOString().slice(0, 10);
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

function formatCost(usd: number): string {
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
  if (cost !== undefined) parts.push(formatCost(cost));
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
