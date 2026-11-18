/**
 * The typed "Run workflow" form (spec FR13): `PlaybookInput[]` metadata in, a `StartRunRequest`
 * out, with the same coercion rules the server applies (`number`/`boolean`/`enum`), so a value the
 * form accepts is a value `POST /runs` accepts.
 */

import type {
  PlaybookInput,
  PlaybookSummary,
  Scalar,
  StartRunRequest,
} from "@thaodangspace/argos-core/rpc/contracts";

/** Raw control values: a text/enum field is a string, a number input a number, a checkbox a boolean. */
export type StartFormValues = Readonly<Record<string, string | number | boolean | undefined>>;

export type FieldErrors = Readonly<Record<string, string>>;

export type BuildStartRequestResult =
  | { readonly ok: true; readonly request: StartRunRequest }
  | { readonly ok: false; readonly errors: FieldErrors };

export interface BuildStartRequestInput {
  readonly playbook: PlaybookSummary;
  readonly cwd: string;
  readonly values: StartFormValues;
  readonly isolation?: "none" | "worktree";
  readonly executor?: string;
}

function coerce(
  definition: PlaybookInput,
  raw: string | number | boolean | undefined,
): { readonly value?: Scalar; readonly error?: string } {
  if (definition.type === "boolean") {
    // An absent control is "unset" (the server fills its default); a present one is a real boolean.
    if (raw === undefined) {
      return definition.required ? { error: `${definition.name} is required` } : {};
    }
    return { value: raw === true || raw === "true" };
  }
  const text =
    typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    return definition.required ? { error: `${definition.name} is required` } : {};
  }
  switch (definition.type) {
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: `${definition.name} must be a number` };
      return { value };
    }
    case "enum": {
      if (definition.values !== undefined && !definition.values.includes(text)) {
        return { error: `${definition.name} must be one of ${definition.values.join(", ")}` };
      }
      return { value: text };
    }
    case "string":
      return { value: text };
  }
}

/** Validate the form and build the request body. `clientRequestId` is added by the dialog. */
export function buildStartRequest(input: BuildStartRequestInput): BuildStartRequestResult {
  const errors: Record<string, string> = {};
  const cwd = input.cwd.trim();
  if (cwd === "") errors["cwd"] = "a working directory is required";

  const inputs: Record<string, Scalar> = {};
  for (const definition of input.playbook.inputs) {
    const result = coerce(definition, input.values[definition.name]);
    if (result.error !== undefined) {
      errors[definition.name] = result.error;
      continue;
    }
    if (result.value !== undefined) inputs[definition.name] = result.value;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    request: {
      playbookId: input.playbook.id,
      cwd,
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      ...(input.isolation === undefined ? {} : { isolation: { mode: input.isolation } }),
      ...(input.executor === undefined ? {} : { executor: input.executor }),
    },
  };
}

/**
 * Initial control values: declared defaults, and `false` for a boolean without one (so an unchecked
 * box is visible rather than implied).
 */
export function initialValues(inputs: readonly PlaybookInput[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const definition of inputs) {
    if (definition.type === "boolean") {
      values[definition.name] = definition.default === true;
      continue;
    }
    if (definition.default !== undefined) values[definition.name] = String(definition.default);
    else values[definition.name] = "";
  }
  return values;
}

/** A fresh idempotency key per dialog open: a double submit cannot start two runs. */
export function newClientRequestId(random: () => number = Math.random): string {
  const value = Math.floor(random() * Number.MAX_SAFE_INTEGER);
  return `ui-${Date.now().toString(36)}-${value.toString(36)}`;
}
