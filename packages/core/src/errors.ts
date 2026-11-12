/**
 * Stable error codes for every Argos surface (plan "Error codes"). The code is part of the
 * public contract: CLI exit paths, RPC bodies, and tests match on it, never on the message.
 */
export const ARGOS_ERROR_CODES = [
  "playbook_invalid",
  "playbook_cycle",
  "playbook_missing",
  "model_unavailable",
  "storage_locked",
  "paseo_unreachable",
  "agent_missing",
  "launch_uncertain",
  "invalid_output",
  "readonly_violation",
  "worktree_failed",
  "worktree_base_dirty",
  "provider_exhausted",
  "gate_already_decided",
  "gate_unknown",
  "loop_limit",
  "step_failed",
  "step_timeout",
  "script_timeout",
  // FR3: a pinned script was edited, moved, or deleted after the run started (HTTP 409).
  "script_changed",
  "concurrency_limit",
  "unauthorized",
  "run_terminal",
  // FR4: a worktree operation named a run that has not finished yet (HTTP 409).
  "run_active",
  // Phase 8 (RPC surface): names the request/route failure instead of guessing a domain code.
  "invalid_request",
  "run_unknown",
  "step_unknown",
] as const;

export type ArgosErrorCode = (typeof ARGOS_ERROR_CODES)[number];

/**
 * One loader/validator problem (FR1.4): the path inside the document, the step it belongs to
 * (FR1.5), and the message. Values never appear — only paths, keys, and step ids (FR7.3).
 */
export interface ArgosIssue {
  readonly path: string;
  readonly stepId?: string;
  readonly message: string;
}

export interface ArgosErrorDetails {
  /** Absolute path of the file the failure belongs to, when there is one. */
  readonly file?: string;
  /** Playbook step the failure belongs to, when there is one. */
  readonly stepId?: string;
  /** Every schema issue the loader found, capped at 20 (FR1.4). */
  readonly issues?: readonly ArgosIssue[];
  readonly cause?: unknown;
}

/**
 * The only error type Argos throws on purpose. `message` always names the file and, when it
 * applies, the step — built by {@link argosError} so every call site is consistent.
 */
export class ArgosError extends Error {
  readonly code: ArgosErrorCode;
  readonly file: string | undefined;
  readonly stepId: string | undefined;
  /** Every issue behind a loader failure; `undefined` for errors that have no schema issues. */
  readonly issues: readonly ArgosIssue[] | undefined;

  constructor(code: ArgosErrorCode, message: string, details: ArgosErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ArgosError";
    this.code = code;
    this.file = details.file;
    this.stepId = details.stepId;
    this.issues = details.issues;
  }
}

/** Message prefix shared by every loader/validator error: `<file>[: step <id>]: `. */
export function errorLocation(file: string | undefined, stepId: string | undefined): string {
  const parts: string[] = [];
  if (file !== undefined) parts.push(file);
  if (stepId !== undefined) parts.push(`step ${stepId}`);
  return parts.length > 0 ? `${parts.join(": ")}: ` : "";
}

/**
 * Build an {@link ArgosError} whose message starts with the file and step. Use this instead of
 * constructing `ArgosError` directly so `code`, `file`, `stepId`, and the text never diverge.
 */
export function argosError(
  code: ArgosErrorCode,
  location: { file?: string | undefined; stepId?: string | undefined },
  detail: string,
  cause?: unknown,
  extra?: { readonly issues?: readonly ArgosIssue[] },
): ArgosError {
  const message = `${errorLocation(location.file, location.stepId)}${detail}`;
  const details: ArgosErrorDetails = {};
  if (location.file !== undefined) Object.assign(details, { file: location.file });
  if (location.stepId !== undefined) Object.assign(details, { stepId: location.stepId });
  if (extra?.issues !== undefined) Object.assign(details, { issues: extra.issues });
  if (cause !== undefined) Object.assign(details, { cause });
  return new ArgosError(code, message, details);
}

/** Narrowing helper for callers that receive `unknown` (RPC, CLI, tests). */
export function isArgosError(value: unknown): value is ArgosError {
  return (
    value instanceof ArgosError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "ArgosError" &&
      typeof (value as { code?: unknown }).code === "string" &&
      (ARGOS_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
