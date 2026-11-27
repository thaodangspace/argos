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

/** The list scoped to one workflow (`?workflow=<id>`), the run page's back-link target. */
export function workflowHref(workflowId: string): string {
  return `${href("/")}?workflow=${encodeURIComponent(workflowId)}`;
}

export function stepHref(runId: string, stepId: string): string {
  return `${runHref(runId)}?step=${encodeURIComponent(stepId)}`;
}

/**
 * The playbook editor, scoped to a directory when one is known (editor FR20/FR21). The `cwd` is what
 * the header link passes: the most recent directory this browser used, so the editor opens on the
 * repository the operator was last working in.
 */
export function playbooksHref(cwd?: string): string {
  const base = href("/playbooks");
  const value = cwd?.trim() ?? "";
  return value === "" ? base : `${base}?cwd=${encodeURIComponent(value)}`;
}
