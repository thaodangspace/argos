/**
 * The run page's view state in the address bar (spec FR17): `?view=graph&step=<id>`.
 *
 * The view is a scope-like choice about *this* run, so it is URL state — shareable, back-button
 * correct, and restored on reload — never `localStorage` (D2). `step` keeps working in both views,
 * so a link is never view-bound. Both parameters are written by the one helper below, so the two
 * never fight over `history.replaceState`.
 *
 * Pure so the round trip is pinned without a DOM.
 */

/** `rail` is the default; `graph` is the DAG view (FR17, FR18). */
export type RunViewMode = "rail" | "graph";

export interface RunViewParams {
  readonly view: RunViewMode;
  /** The step whose log is open, or null when the page picks one. */
  readonly step: string | null;
}

/** Unknown or malformed values fall back to the rail, so a hand-edited URL never breaks a page. */
export function readViewParams(search: string): RunViewParams {
  const params = new URLSearchParams(search);
  const step = params.get("step");
  return {
    view: params.get("view") === "graph" ? "graph" : "rail",
    step: step === null || step === "" ? null : step,
  };
}

/**
 * Write both parameters into `url` and hand it back (the caller passes `new URL(location.href)` and
 * gives the result to `history.replaceState`). `?view=rail` is the same state as no parameter at
 * all, so the default gets the clean URL.
 */
export function writeViewParams(url: URL, params: RunViewParams): URL {
  if (params.view === "graph") url.searchParams.set("view", "graph");
  else url.searchParams.delete("view");
  if (params.step === null || params.step === "") url.searchParams.delete("step");
  else url.searchParams.set("step", params.step);
  return url;
}
