/**
 * The one start path both `POST /runs` and a schedule fire use (FR4.1, FR2.4).
 *
 * `resolveRunRequest` is the read-only front half of a start: it validates the run's `cwd`,
 * loads (and validates) the playbook, and coerces/fills the declared inputs. It writes nothing, so
 * a refused request can never leave a task, a worktree, or a run behind, and the scheduler can run
 * it both as a real fire and as the `argos schedule add/edit` dry check.
 *
 * The helpers moved here **verbatim** from `rpc/server.ts` (same codes, same messages) so an HTTP
 * request and a fire cannot drift apart. This module is imported by `rpc/server.ts` (serve-only) and
 * by `durable/`; it is deliberately not exported from `durable/index.ts`, so `argos-core/durable`
 * keeps exactly the surface it had.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { ArgosError } from "../errors.js";
import { loadPlaybook } from "../playbook/index.js";
import type { InputDefIR, PlaybookIR, Scalar } from "../playbook/ir.js";

/** What a caller asks for, before any validation: the RPC body, or a schedule's stored values. */
export interface RunRequest {
  readonly playbookId: string;
  readonly cwd: string;
  readonly inputs?: Readonly<Record<string, Scalar>>;
  /** `$ARGOS_HOME` for global playbooks (`<home>/playbooks`); omit for repo-only discovery. */
  readonly home?: string;
}

/** The frozen playbook plus the resolved inputs and the directory the run works in. */
export interface ResolvedRunRequest {
  readonly ir: PlaybookIR;
  readonly inputs: Record<string, Scalar>;
  readonly cwd: string;
}

/**
 * Resolve one run request (FR4.1): `cwd` first, then the loader, then the inputs.
 *
 * The order is the contract: a bad `cwd` is `invalid_request` **before** the loader runs (FR6.1),
 * an unknown/invalid playbook is `playbook_missing`/`playbook_invalid` from the loader, and a bad or
 * missing input is `invalid_request` from `prepareInputs`. Every failure happens before any task
 * exists.
 */
export function resolveRunRequest(request: RunRequest): ResolvedRunRequest {
  const cwd = request.cwd;
  validateRunCwd(cwd);
  // The loader is read-only. A schedule fire loads at fire time and freezes its own IR + hash, so
  // an edited playbook takes effect on the next fire, never mid-run (FR4.2).
  const ir = loadPlaybook(
    cwd,
    request.playbookId,
    request.home === undefined ? {} : { home: request.home },
  );
  return { ir, inputs: prepareInputs(ir, request.inputs ?? {}), cwd };
}

/** Coerce one provided value to the playbook input's declared type. */
export function coerceInput(
  ir: PlaybookIR,
  name: string,
  def: InputDefIR,
  value: Scalar,
): Scalar {
  switch (def.type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      throw new ArgosError(
        "invalid_request",
        `playbook ${ir.id}: input "${name}" must be a number`,
      );
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw new ArgosError(
        "invalid_request",
        `playbook ${ir.id}: input "${name}" must be true or false`,
      );
    }
    case "enum": {
      const text = String(value);
      if (def.values !== undefined && !def.values.includes(text)) {
        throw new ArgosError(
          "invalid_request",
          `playbook ${ir.id}: input "${name}" must be one of ${def.values.join(", ")}`,
        );
      }
      return text;
    }
    case "string": {
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;
    }
  }
}

/** Declared defaults, required-input checks, and CLI string coercion (FR7). */
export function prepareInputs(
  ir: PlaybookIR,
  provided: Readonly<Record<string, Scalar>>,
): Record<string, Scalar> {
  const result: Record<string, Scalar> = {};
  for (const [name, def] of Object.entries(ir.inputs)) {
    const value = provided[name];
    if (value === undefined) {
      if (def.default !== undefined) result[name] = def.default;
      else if (def.required === true) {
        throw new ArgosError(
          "invalid_request",
          `playbook ${ir.id}: missing required input "${name}"`,
        );
      }
      continue;
    }
    result[name] = coerceInput(ir, name, def, value);
  }
  // Undeclared scalars stay available to templates, exactly like the engine's input map.
  for (const [name, value] of Object.entries(provided)) {
    if (!(name in result)) result[name] = value;
  }
  return result;
}

/**
 * A run's `cwd` must be absolute, NUL-free, and an existing directory (FR6.1). A git repository
 * is deliberately not required: scripts and agents can work in any directory the operator names.
 * The check runs before `loadPlaybook`, so a refused cwd never creates a run or a worktree.
 */
export function validateRunCwd(cwd: string): void {
  if (cwd.includes("\0")) {
    throw new ArgosError("invalid_request", "cwd must not contain a NUL byte");
  }
  if (!isAbsolute(cwd)) {
    throw new ArgosError("invalid_request", `cwd ${JSON.stringify(cwd)} is not an absolute path`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(cwd);
  } catch {
    throw new ArgosError("invalid_request", `cwd ${JSON.stringify(cwd)} does not exist`);
  }
  if (!stats.isDirectory()) {
    throw new ArgosError("invalid_request", `cwd ${JSON.stringify(cwd)} is not a directory`);
  }
}
