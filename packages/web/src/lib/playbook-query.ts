/**
 * The editor's scope in the URL (editor FR20): `?cwd=<abs>&file=<abs>`.
 *
 * The address bar is the editor's state, exactly as it is the list's (`lib/list-query.ts`): a scope
 * is then shareable, a reload reopens the same file, and the back button steps through the
 * selections. Both values are paths, so neither is coerced — a hand-edited URL that names a file
 * discovery does not list is refused by the server (`invalid_request`), which is the honest answer.
 *
 * Pure, so the round trip is pinned without a DOM.
 */

/** What the editor is scoped to. `null` means "not chosen": the page then asks the server. */
export interface PlaybookSelection {
  readonly cwd: string | null;
  readonly file: string | null;
}

export const EMPTY_PLAYBOOK_SELECTION: PlaybookSelection = { cwd: null, file: null };

function text(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value.trim();
}

/** Unknown keys and an empty or partial query are tolerated: the page falls back, never errors. */
export function parsePlaybookQuery(search: string): PlaybookSelection {
  const params = new URLSearchParams(search);
  return { cwd: text(params.get("cwd")), file: text(params.get("file")) };
}

/** An unset value is omitted, so the plain editor keeps a clean URL. */
export function playbookQueryToSearch(selection: PlaybookSelection): string {
  const params = new URLSearchParams();
  if (selection.cwd !== null) params.set("cwd", selection.cwd);
  if (selection.file !== null) params.set("file", selection.file);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
