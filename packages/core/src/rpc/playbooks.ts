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
  SECRET_INPUT_NAME_PATTERN,
  type PlaybookInput,
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
 * List every playbook discoverable from `cwd` (and the host's `home`), with per-file failures.
 *
 * `cwd` must already have passed `validateRunCwd`; this function performs no validation of its own.
 *
 * `options.graph` (FR8) adds the projected DAG to each summary. It is opt-in because the listing is
 * polled for the start form: the default body is byte-identical to the pre-graph response.
 */
export function listPlaybooks(
  cwd: string,
  home?: string,
  options: { graph?: boolean } = {},
): PlaybookListResponse {
  const withGraph = options.graph === true;
  const playbooks: PlaybookSummary[] = [];
  const errors: PlaybookLoadError[] = [];
  for (const entry of discoverPlaybooks(cwd, home)) {
    try {
      const ir = loadPlaybook(cwd, entry.id, home === undefined ? {} : { home });
      playbooks.push(toSummary(ir, entry.file, withGraph));
    } catch (error) {
      errors.push({
        file: entry.file,
        code: isArgosError(error) ? error.code : "playbook_invalid",
        message: errorMessage(error),
      });
    }
  }
  return { cwd, playbooks, errors };
}
