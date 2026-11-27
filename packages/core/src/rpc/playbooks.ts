/**
 * `GET /playbooks` (spec FR4): discovery + input metadata for the UI's "Run workflow" form.
 *
 * The rules mirror `POST /runs`, because the form must never offer something a start would refuse:
 * the same cwd validation, the same repository-then-home discovery, and the same loader. A playbook
 * that fails to load is reported per file instead of failing the whole listing, so one broken YAML
 * cannot hide the rest of the repository.
 *
 * Nothing here is execution: no task, no worktree, no run, no model check. The route is read-only.
 */

import { isArgosError } from "../errors.js";
import { buildPlaybookGraph } from "../playbook/graph.js";
import { discoverPlaybooks, loadPlaybook } from "../playbook/load.js";
import type { InputDefIR, PlaybookIR } from "../playbook/ir.js";
import {
  PLAYBOOK_ISSUE_LIMIT,
  SECRET_INPUT_NAME_PATTERN,
  type PlaybookInput,
  type PlaybookIssue,
  type PlaybookListResponse,
  type PlaybookLoadError,
  type PlaybookSummary,
} from "./contracts.js";

/** Bounded so a pathological description cannot bloat the response. */
const DESCRIPTION_LIMIT = 500;

function clampText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function toInput(name: string, definition: InputDefIR): PlaybookInput {
  const secret = SECRET_INPUT_NAME_PATTERN.test(name);
  return {
    name,
    type: definition.type,
    required: definition.required === true,
    ...(definition.default === undefined || secret ? {} : { default: definition.default }),
    ...(definition.values === undefined ? {} : { values: [...definition.values] }),
    ...(definition.description === undefined
      ? {}
      : { description: clampText(definition.description, DESCRIPTION_LIMIT) }),
  };
}

function toSummary(ir: PlaybookIR, file: string, withGraph: boolean): PlaybookSummary {
  return {
    id: ir.id,
    file,
    hash: ir.hash,
    inputs: Object.entries(ir.inputs).map(([name, definition]) => toInput(name, definition)),
    ...(ir.executor === undefined ? {} : { executor: ir.executor }),
    ...(ir.isolation === undefined ? {} : { isolation: ir.isolation.mode }),
    stepCount: ir.steps.length,
    // FR8: projected on request only, so the default listing stays byte-identical for every client.
    ...(withGraph ? { graph: buildPlaybookGraph(ir) } : {}),
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return clampText(raw, DESCRIPTION_LIMIT);
}

/**
 * The loader's per-issue detail, capped at {@link PLAYBOOK_ISSUE_LIMIT} (FR8). Built key by key so a
 * strict parse sees exactly `path`, `stepId`, `message` — an `ArgosIssue` never carries more, and
 * this is the one place the cap is applied (the schema states the shape, not the limit).
 */
function toIssues(error: unknown): PlaybookIssue[] {
  if (!isArgosError(error) || error.issues === undefined) return [];
  return error.issues.slice(0, PLAYBOOK_ISSUE_LIMIT).map((issue) => ({
    path: issue.path,
    ...(issue.stepId === undefined ? {} : { stepId: issue.stepId }),
    message: issue.message,
  }));
}

/**
 * Project one loader failure to its `errors[]` entry. `withIssues` (FR8) adds the loader's issue list;
 * without it the entry is the pre-editor shape, byte for byte. A failure that carries no issues (a
 * graph check, say) omits the key even when asked, so a client never sees an empty array it would
 * have to distinguish from "no detail available". Exported so the cap is testable without a
 * repository that somehow produces more than the loader's own limit.
 */
export function toPlaybookLoadError(
  file: string,
  error: unknown,
  withIssues: boolean,
): PlaybookLoadError {
  const issues = withIssues ? toIssues(error) : [];
  return {
    file,
    code: isArgosError(error) ? error.code : "playbook_invalid",
    message: errorMessage(error),
    ...(issues.length === 0 ? {} : { issues }),
  };
}

/**
 * List every playbook discoverable from `cwd` (and the host's `home`), with per-file failures.
 *
 * `cwd` must already have passed `validateRunCwd`; this function performs no validation of its own.
 *
 * `options.graph` (FR8) adds the projected DAG to each summary. It is opt-in because the listing is
 * polled for the start form: the default body is byte-identical to the pre-graph response.
 *
 * `options.issues` (editor FR8) adds the loader's `issues[]` to each `errors[]` entry. It is opt-in
 * for the same reason: without the flag the body is byte-identical to the pre-editor listing.
 */
export function listPlaybooks(
  cwd: string,
  home?: string,
  options: { graph?: boolean; issues?: boolean } = {},
): PlaybookListResponse {
  const withGraph = options.graph === true;
  const withIssues = options.issues === true;
  const playbooks: PlaybookSummary[] = [];
  const errors: PlaybookLoadError[] = [];
  for (const entry of discoverPlaybooks(cwd, home)) {
    try {
      const ir = loadPlaybook(cwd, entry.id, home === undefined ? {} : { home });
      playbooks.push(toSummary(ir, entry.file, withGraph));
    } catch (error) {
      errors.push(toPlaybookLoadError(entry.file, error, withIssues));
    }
  }
  return { cwd, playbooks, errors };
}
