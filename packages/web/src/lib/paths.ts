/**
 * Links inside the SPA (spec FR1). The app is served under `UI_BASE`, so every anchor and every
 * `window.location.assign` needs that prefix; a root-relative `/runs/x` would miss it.
 */

import { UI_BASE } from "./base.js";

/** `/runs/x` → `/ui/runs/x`. */
export function href(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${UI_BASE}${suffix}`;
}

export function runHref(runId: string): string {
  return href(`/runs/${encodeURIComponent(runId)}`);
}

export function stepHref(runId: string, stepId: string): string {
  return `${runHref(runId)}?step=${encodeURIComponent(stepId)}`;
}
