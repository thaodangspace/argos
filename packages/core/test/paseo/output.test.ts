import { describe, expect, it } from "vitest";

import {
  buildStepOutputSchema,
  extractJsonResult,
  parseStepResult,
  providerOutputCapability,
  validateStepOutput,
} from "../../src/paseo/output.js";

const outputs = {
  summary: { type: "string" as const, required: true },
  count: { type: "number" as const },
  mode: { type: "enum" as const, values: ["fast", "safe"] },
  flag: { type: "boolean" as const, default: false },
};

describe("output schema (D12/FR17)", () => {
  it("compiles outputs and outcomes into one required-key object schema", () => {
    const compiled = buildStepOutputSchema({
      outputs,
      outcomes: ["success", "failure"],
    });
    expect(compiled.hasOutputs).toBe(true);
    expect(compiled.hasSchema).toBe(true);
    expect(compiled.schema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
        count: { type: "number" },
        mode: { type: "string", enum: ["fast", "safe"] },
        flag: { type: "boolean" },
        outcome: { type: "string", enum: ["success", "failure"] },
      },
      required: ["summary", "outcome"],
      additionalProperties: false,
    });
  });

  it("emits an empty schema when the step declares nothing", () => {
    const compiled = buildStepOutputSchema({ outputs: {}, outcomes: [] });
    expect(compiled.hasSchema).toBe(false);
    expect(compiled.schema).toEqual({});
    expect(parseStepResult(compiled, { text: "anything" })).toEqual({ ok: true, outputs: {} });
  });

  it("applies defaults, enforces types, enums, required keys, and unknown keys", () => {
    const compiled = buildStepOutputSchema({ outputs, outcomes: ["success"] });

    const valid = validateStepOutput(compiled, {
      summary: "done",
      mode: "fast",
      outcome: "success",
    });
    expect(valid).toEqual({
      ok: true,
      outcome: "success",
      outputs: { summary: "done", mode: "fast", flag: false },
    });

    expect(validateStepOutput(compiled, { outcome: "success" }).ok).toBe(false);
    expect(
      validateStepOutput(compiled, { summary: "done", count: "3", outcome: "success" }),
    ).toEqual({
      ok: false,
      code: "invalid_output",
      error: "output count: expected number, received string",
    });
    expect(
      validateStepOutput(compiled, { summary: "done", mode: "turbo", outcome: "success" }),
    ).toEqual({
      ok: false,
      code: "invalid_output",
      error: 'output mode: "turbo" is not one of fast, safe',
    });
    expect(
      validateStepOutput(compiled, { summary: "done", outcome: "maybe" }),
    ).toEqual({
      ok: false,
      code: "invalid_output",
      error: 'outcome: "maybe" is not one of success',
    });
    expect(
      validateStepOutput(compiled, { summary: "done", outcome: "success", extra: 1 }),
    ).toEqual({ ok: false, code: "invalid_output", error: 'unexpected key "extra"' });
    expect(validateStepOutput(compiled, "not an object").ok).toBe(false);
  });

  it("parses a single fenced json block, rejects ambiguity, and accepts bare objects", () => {
    expect(extractJsonResult('here:\n```json\n{"a":1}\n```\n')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(extractJsonResult('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toEqual({
      ok: false,
      error: "expected one fenced json block, found 2",
    });
    expect(extractJsonResult('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJsonResult("no json here").ok).toBe(false);
  });

  it("uses the text fallback only when the step declares outputs", () => {
    const compiled = buildStepOutputSchema({ outputs, outcomes: ["success"] });
    const parsed = parseStepResult(compiled, {
      text: '```json\n{"summary":"ok","outcome":"success"}\n```',
    });
    expect(parsed).toEqual({
      ok: true,
      outcome: "success",
      outputs: { summary: "ok", flag: false },
    });

    // Outcomes alone are not enough for prose parsing: the step declares no outputs.
    const outcomesOnly = buildStepOutputSchema({ outputs: {}, outcomes: ["success"] });
    expect(
      parseStepResult(outcomesOnly, { text: '{"outcome":"success"}' }),
    ).toEqual({
      ok: false,
      code: "invalid_output",
      error: "the provider returned plain text but the step declares no outputs",
    });

    // A structured value still validates even with outcomes only.
    expect(parseStepResult(outcomesOnly, { output: { outcome: "success" } })).toEqual({
      ok: true,
      outcome: "success",
      outputs: {},
    });
  });

  it("prefers a structured output and never re-parses prose after it fails validation", () => {
    const compiled = buildStepOutputSchema({ outputs, outcomes: ["success"] });
    expect(
      parseStepResult(compiled, {
        output: { summary: 42, outcome: "success" },
        text: '```json\n{"summary":"ok","outcome":"success"}\n```',
      }),
    ).toEqual({
      ok: false,
      code: "invalid_output",
      error: "output summary: expected string, received number",
    });
  });

  it("documents per-provider structured-output capability", () => {
    expect(providerOutputCapability("claude/opus")).toBe("structured");
    expect(providerOutputCapability("opencode/big")).toBe("text");
    expect(providerOutputCapability("unknown/model")).toBe("structured");
    expect(providerOutputCapability(undefined)).toBe("structured");
  });
});
