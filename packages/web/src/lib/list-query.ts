/**
 * The list query in the URL (spec FR11): `?workflow=…&project=…&status=…&trigger=…&sort=…`.
 *
 * The address bar is the list's state. A filtered view is then shareable, the back button works, and
 * a reload keeps the scope — the same reason GitHub keeps its Actions filters in the query string.
 * Pure so the parse/serialize round trip is testable without a DOM.
 */

import {
  RUN_FILTERS,
  RUN_SORTS,
  RUN_TRIGGERS,
  type RunFilter,
  type RunListQuery,
  type RunSort,
  type RunTriggerFacet,
} from "@thaodangspace/argos-core/view";

/** The full list state: the facet query plus the order. */
export interface ListState extends RunListQuery {
  readonly sort: RunSort;
}

export const DEFAULT_LIST_STATE: ListState = { status: "all", sort: "start" };

function oneOf<T extends string>(values: readonly T[], candidate: string | null): T | undefined {
  return candidate !== null && (values as readonly string[]).includes(candidate)
    ? (candidate as T)
    : undefined;
}

function text(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Unknown or malformed values fall back to the default instead of failing the page. */
export function parseListState(search: string): ListState {
  const params = new URLSearchParams(search);
  const status = oneOf<RunFilter>(RUN_FILTERS, params.get("status")) ?? DEFAULT_LIST_STATE.status;
  const sort = oneOf<RunSort>(RUN_SORTS, params.get("sort")) ?? DEFAULT_LIST_STATE.sort;
  const project = text(params.get("project"));
  const workflow = text(params.get("workflow"));
  const trigger = oneOf<RunTriggerFacet>(RUN_TRIGGERS, params.get("trigger"));
  const executor = text(params.get("executor"));
  return {
    status,
    sort,
    ...(project === undefined ? {} : { project }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(executor === undefined ? {} : { executor }),
  };
}

/** Defaults are omitted, so the plain list keeps a clean URL. */
export function listStateToSearch(state: ListState): string {
  const params = new URLSearchParams();
  if (state.status !== DEFAULT_LIST_STATE.status) params.set("status", state.status);
  if (state.sort !== DEFAULT_LIST_STATE.sort) params.set("sort", state.sort);
  if (state.project !== undefined) params.set("project", state.project);
  if (state.workflow !== undefined) params.set("workflow", state.workflow);
  if (state.trigger !== undefined) params.set("trigger", state.trigger);
  if (state.executor !== undefined) params.set("executor", state.executor);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** A patch where `undefined` explicitly clears a facet (the "All workflows" entry point). */
export type ListStatePatch = { readonly [K in keyof ListState]?: ListState[K] | undefined };

export function mergeListState(state: ListState, patch: ListStatePatch): ListState {
  const merged: Record<string, unknown> = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as ListState;
}
