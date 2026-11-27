/**
 * The playbook read surface: `GET /playbooks` (spec FR4) and, for the editor, `GET /playbooks/file`
 * (FR1) and `POST /playbooks/validate` (FR6).
 *
 * The rules mirror `POST /runs`, because the form must never offer something a start would refuse:
 * the same cwd validation, the same repository-then-home discovery, and the same loader. A playbook
 * that fails to load is reported per file instead of failing the whole listing, so one broken YAML
 * cannot hide the rest of the repository. The editor routes project the same loader and add no
 * second validator.
 *
 * Nothing here is execution: no task, no worktree, no run, no model check, and no write. The `file`
 * of a read or validate request is never trusted — containment lives in `playbook-write.ts`.
 */

import { isArgosError } from "../errors.js";
import { buildPlaybookGraph } from "../playbook/graph.js";
import { discoverPlaybooks, loadPlaybook, type LoadWarning } from "../playbook/load.js";
import type { InputDefIR, PlaybookIR } from "../playbook/ir.js";
import {
  PLAYBOOK_ISSUE_LIMIT,
  SECRET_INPUT_NAME_PATTERN,
  type PlaybookFileResponse,
  type PlaybookInput,
  type PlaybookIssue,
  type PlaybookListResponse,
  type PlaybookLoadError,
  type PlaybookSummary,
  type PlaybookVerdict,
  type ValidateWarning,
} from "./contracts.js";
import {
  assertPlaybookTextWithinLimit,
  readPlaybookSource,
  resolvePlaybookTarget,
  type PlaybookTarget,
} from "./playbook-write.js";

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

/**
 * The loader's warnings in the wire shape (FR6). A warning never carries a YAML value, only a file,
 * a step id, a code, and a message; `stepId` is `null` for a file-level finding.
 */
function toValidateWarnings(warnings: readonly LoadWarning[]): ValidateWarning[] {
  return warnings.map((warning) => ({
    file: warning.file,
    stepId: warning.stepId,
    code: warning.code,
    message: warning.message,
  }));
}

/**
 * The one verdict read, validate, and save share (FR6/FR13): the loader is the only validator, so a
 * buffer and the identical bytes on disk cannot disagree. A failure is a verdict, never a throw: the
 * loader's own `errors[]` (with its `issues[]`) is what an operator needs to fix the file.
 */
function toVerdict(
  target: PlaybookTarget,
  yaml: string,
  options: { readonly home?: string; readonly graph?: boolean },
): PlaybookVerdict {
  const warnings: LoadWarning[] = [];
  try {
    const ir = loadPlaybook(target.repoDir, target.id, {
      ...(options.home === undefined ? {} : { home: options.home }),
      warnings,
      // FR7: the buffer takes the place of the file's bytes only; the path identity stays real.
      source: { file: target.file, text: yaml },
    });
    return {
      playbookId: ir.id,
      valid: true,
      errors: [],
      warnings: toValidateWarnings(warnings),
      hash: ir.hash,
      ...(options.graph === true ? { graph: buildPlaybookGraph(ir) } : {}),
    };
  } catch (error) {
    return {
      playbookId: target.id,
      valid: false,
      errors: [toPlaybookLoadError(target.file, error, true)],
      warnings: toValidateWarnings(warnings),
    };
  }
}

/**
 * `GET /playbooks/file` (FR1/FR2): one discovered playbook's raw text, the digest of those bytes,
 * the loader's verdict, its warnings, and the graph when asked.
 *
 * A file that does not load is still a `200` answer (`valid: false`, `errors[]`): an operator has to
 * be able to read and fix a broken playbook. Containment and the size cap live in
 * {@link resolvePlaybookTarget}; `cwd` has already passed `validateRunCwd` at the route.
 */
export function readPlaybookFile(input: {
  readonly cwd: string;
  readonly file: string;
  readonly home?: string;
  readonly graph?: boolean;
}): PlaybookFileResponse {
  const target = resolvePlaybookTarget({
    cwd: input.cwd,
    file: input.file,
    ...(input.home === undefined ? {} : { home: input.home }),
  });
  // One read, so the published `yaml` and `sha256` are always the same bytes.
  const source = readPlaybookSource(target);
  const verdict = toVerdict(target, source.yaml, {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.graph === true ? { graph: true } : {}),
  });
  return {
    ...verdict,
    cwd: input.cwd,
    file: target.file,
    yaml: source.yaml,
    sha256: source.sha256,
  };
}

/**
 * `POST /playbooks/validate` (FR6/FR7): the verdict for a buffer, against a discovered file's
 * identity, writing nothing. Containment first (the file must be a discovered repository or home
 * playbook), then the text cap, then the loader — there is no second YAML parser anywhere.
 */
export function validatePlaybookBuffer(input: {
  readonly cwd: string;
  readonly file: string;
  readonly yaml: string;
  readonly home?: string;
  readonly graph?: boolean;
}): PlaybookVerdict {
  const target = resolvePlaybookTarget({
    cwd: input.cwd,
    file: input.file,
    ...(input.home === undefined ? {} : { home: input.home }),
  });
  assertPlaybookTextWithinLimit(input.yaml);
  return toVerdict(target, input.yaml, {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.graph === true ? { graph: true } : {}),
  });
}
