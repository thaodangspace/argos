/**
 * Structured step results (D12, FR17).
 *
 * A step's declared `outputs` and `outcomes` compile to **one** JSON Schema that is passed to
 * `agents.create({ outputSchema })`. The agent reports a single object:
 *
 * ```json
 * { "summary": "…", "count": 3, "outcome": "success" }
 * ```
 *
 * No custom report tool and no prose parsing: the schema is the contract. The one documented
 * fallback is when a provider ignores `outputSchema` and returns text anyway — then, and only
 * when the step declares `outputs`, a single fenced ```json block (or a bare JSON object) is
 * parsed and validated like a structured result.
 *
 * `PROVIDER_OUTPUT_CAPABILITIES` records what the manual probe
 * (`scripts/probe-output-schema.ts`) observed per provider. It is **not** a CI probe: the map is
 * documentation plus a hook for `argos doctor`, and the parser always accepts both shapes.
 */

import type { OutputDefIR, Scalar } from "../playbook/ir.js";

// ------------------------------------------------------------------ schema

/** One compiled output property (name + frozen IR definition). */
export interface CompiledOutput {
  readonly name: string;
  readonly def: OutputDefIR;
}

/** The compiled schema plus the metadata the validator needs. */
export interface StepOutputSchema {
  /** The JSON Schema handed to the provider. Empty (`{}`) when the step declares nothing. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly outputs: readonly CompiledOutput[];
  readonly outcomes: readonly string[];
  /** True when the step declares at least one output (gates the text fallback, D12). */
  readonly hasOutputs: boolean;
  /** True when there is anything at all to validate. */
  readonly hasSchema: boolean;
}

function outputPropertySchema(def: OutputDefIR): Readonly<Record<string, unknown>> {
  switch (def.type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return {
        type: "string",
        ...(def.values === undefined ? {} : { enum: [...def.values] }),
      };
    case "string":
      return { type: "string" };
  }
}

/**
 * Compile `outputs` + `outcomes` into the single object schema the provider must satisfy.
 * Required keys are the outputs marked `required` plus `outcome` whenever the step declares
 * outcomes (the engine needs it to route the transition).
 */
export function buildStepOutputSchema(input: {
  readonly outputs: Readonly<Record<string, OutputDefIR>>;
  readonly outcomes: readonly string[];
}): StepOutputSchema {
  const outputs: CompiledOutput[] = Object.entries(input.outputs).map(([name, def]) => ({
    name,
    def,
  }));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const output of outputs) {
    properties[output.name] = outputPropertySchema(output.def);
    if (output.def.required === true && output.def.default === undefined) required.push(output.name);
  }
  if (input.outcomes.length > 0) {
    properties["outcome"] = { type: "string", enum: [...input.outcomes] };
    required.push("outcome");
  }
  const hasOutputs = outputs.length > 0;
  const hasSchema = hasOutputs || input.outcomes.length > 0;
  const schema = hasSchema
    ? {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      }
    : {};
  return { schema, outputs, outcomes: [...input.outcomes], hasOutputs, hasSchema };
}

// ------------------------------------------------------------------ validation

export type StepOutputValidation =
  | {
      readonly ok: true;
      readonly outcome?: string;
      readonly outputs: Readonly<Record<string, Scalar>>;
    }
  | { readonly ok: false; readonly error: string; readonly code: "invalid_output" };

function invalid(error: string): StepOutputValidation {
  return { ok: false, code: "invalid_output", error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateScalar(
  name: string,
  def: OutputDefIR,
  value: unknown,
): { readonly ok: true; readonly value: Scalar } | { readonly ok: false; readonly error: string } {
  switch (def.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, error: `output ${name}: expected number, received ${describe(value)}` };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: `output ${name}: expected boolean, received ${describe(value)}` };
    case "enum": {
      if (typeof value !== "string") {
        return { ok: false, error: `output ${name}: expected enum string, received ${describe(value)}` };
      }
      if (def.values !== undefined && !def.values.includes(value)) {
        return {
          ok: false,
          error: `output ${name}: "${value}" is not one of ${def.values.join(", ")}`,
        };
      }
      return { ok: true, value };
    }
    case "string":
      return typeof value === "string"
        ? { ok: true, value }
        : { ok: false, error: `output ${name}: expected string, received ${describe(value)}` };
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Validate the provider's object against the compiled schema. Applies declared defaults for
 * missing optional outputs, rejects unknown keys (the schema says `additionalProperties: false`),
 * and requires `outcome` when the step declares outcomes.
 */
export function validateStepOutput(
  compiled: StepOutputSchema,
  value: unknown,
): StepOutputValidation {
  if (!compiled.hasSchema) {
    // Nothing declared: any result completes the step without outputs or an outcome.
    return { ok: true, outputs: {} };
  }
  if (!isPlainObject(value)) {
    return invalid(`expected a JSON object, received ${describe(value)}`);
  }

  const known = new Set(compiled.outputs.map((output) => output.name));
  if (compiled.outcomes.length > 0) known.add("outcome");
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return invalid(`unexpected key "${key}"`);
  }

  let outcome: string | undefined;
  if (compiled.outcomes.length > 0) {
    const raw = value["outcome"];
    if (typeof raw !== "string") {
      return invalid(`outcome: expected one of ${compiled.outcomes.join(", ")}`);
    }
    if (!compiled.outcomes.includes(raw)) {
      return invalid(`outcome: "${raw}" is not one of ${compiled.outcomes.join(", ")}`);
    }
    outcome = raw;
  }

  const outputs: Record<string, Scalar> = {};
  for (const output of compiled.outputs) {
    const raw = value[output.name];
    if (raw === undefined) {
      if (output.def.default !== undefined) outputs[output.name] = output.def.default;
      else if (output.def.required === true) return invalid(`output ${output.name}: required`);
      continue;
    }
    const scalar = validateScalar(output.name, output.def, raw);
    if (!scalar.ok) return invalid(scalar.error);
    outputs[output.name] = scalar.value;
  }

  return {
    ok: true,
    outputs,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

// ------------------------------------------------------------------ plain-text fallback

/** The raw result the port observed: a structured `output`, text, or both. */
export interface RawStepResult {
  readonly output?: unknown;
  readonly text?: string | null;
  readonly provider?: string;
}

/**
 * Parse a single fenced ```json block, or a bare JSON object. More than one fenced block is
 * ambiguous and therefore invalid — the adapter never guesses which one is the answer.
 */
export function extractJsonResult(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  if (fences.length > 1) {
    return { ok: false, error: `expected one fenced json block, found ${fences.length}` };
  }
  if (fences.length === 1) {
    const body = fences[0]?.[1];
    if (body === undefined) return { ok: false, error: "empty fenced json block" };
    try {
      return { ok: true, value: JSON.parse(body) as unknown };
    } catch (cause) {
      return { ok: false, error: `fenced block is not valid JSON: ${(cause as Error).message}` };
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (cause) {
      return { ok: false, error: `text is not valid JSON: ${(cause as Error).message}` };
    }
  }
  return { ok: false, error: "no structured output and no json block in the agent message" };
}

/**
 * Validate whatever the provider returned. Structured `output` wins; text is parsed only when the
 * step declares `outputs` (D12). A step that declares nothing accepts any result.
 */
export function parseStepResult(
  compiled: StepOutputSchema,
  raw: RawStepResult,
): StepOutputValidation {
  if (!compiled.hasSchema) return { ok: true, outputs: {} };

  let candidate: unknown = raw.output;
  let text = raw.text ?? null;

  // Some providers carry the object as a JSON string in `output`; treat it as text.
  if (typeof candidate === "string") {
    text = candidate;
    candidate = undefined;
  }

  if (candidate !== undefined) {
    const validated = validateStepOutput(compiled, candidate);
    if (validated.ok) return validated;
    // A structured object that fails validation is a hard failure: do not re-parse text that
    // may be an unrelated prose summary.
    return validated;
  }

  if (!compiled.hasOutputs) {
    return invalid("the provider returned plain text but the step declares no outputs");
  }
  if (text === null || text.trim().length === 0) {
    return invalid("the provider returned no result");
  }
  const extracted = extractJsonResult(text);
  if (!extracted.ok) return invalid(extracted.error);
  return validateStepOutput(compiled, extracted.value);
}

// ------------------------------------------------------------------ per-provider capability (D12)

/**
 * What the manual probe observed. `structured` means the provider honoured `outputSchema`;
 * `text` means it returned prose and the adapter must use the fenced-JSON fallback. Unknown
 * providers are assumed `structured` and still benefit from the fallback.
 *
 * Run `node --experimental-strip-types scripts/probe-output-schema.ts` against a live daemon to
 * refresh this map (see AGENTS.md). It never runs in CI or in the test suite.
 */
export type ProviderOutputCapability = "structured" | "text";

export const PROVIDER_OUTPUT_CAPABILITIES: Readonly<Record<string, ProviderOutputCapability>> = {
  claude: "structured",
  codex: "structured",
  opencode: "text",
  pi: "structured",
};

/** Capability for a `provider/model` target (`provider` part only). */
export function providerOutputCapability(target: string | undefined): ProviderOutputCapability {
  if (target === undefined) return "structured";
  const provider = target.split("/", 1)[0] ?? target;
  return PROVIDER_OUTPUT_CAPABILITIES[provider] ?? "structured";
}
