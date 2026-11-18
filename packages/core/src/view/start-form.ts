/**
 * The CLI/panel-style start form, parsed without a framework (spec FR6).
 *
 * The web UI does not use `key=value` text, but it uses the same validation result shape and error
 * vocabulary; keeping this here means both clients reject the same malformed input with the same
 * `invalid_request` code.
 */

import type { Scalar, StartRunRequest } from "../rpc/contracts.js";
import type { PanelError } from "./errors.js";

export interface StartFormInput {
  readonly playbookId: string;
  /** Empty means "the server's default cwd". */
  readonly cwd: string;
  /** `key=value` per line, or one JSON object (`{"ticket": 42}`) for typed values. */
  readonly inputs: string;
}

export type StartFormResult =
  | { readonly ok: true; readonly request: StartRunRequest }
  | { readonly ok: false; readonly error: PanelError };

function invalidForm(message: string): StartFormResult {
  return { ok: false, error: { code: "invalid_request", message } };
}

/**
 * Turn a start form into a `POST /runs` body. `key=value` lines stay strings (the loader validates
 * against the playbook's declared inputs); a JSON object keeps numbers/booleans.
 */
export function parseStartForm(form: StartFormInput): StartFormResult {
  const playbookId = form.playbookId.trim();
  if (playbookId === "") return invalidForm("playbook id is required");
  const cwd = form.cwd.trim();
  const raw = form.inputs.trim();
  const inputs: Record<string, Scalar> = {};
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalidForm("inputs are not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return invalidForm("inputs JSON must be an object");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return invalidForm(`input "${key}" must be a string, number or boolean`);
      }
      inputs[key] = value;
    }
  } else if (raw !== "") {
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const eq = line.indexOf("=");
      const key = eq === -1 ? "" : line.slice(0, eq).trim();
      if (key === "") return invalidForm(`expected key=value, got "${line.trim()}"`);
      inputs[key] = line.slice(eq + 1).trim();
    }
  }
  return {
    ok: true,
    request: {
      playbookId,
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      ...(cwd === "" ? {} : { cwd }),
    },
  };
}
