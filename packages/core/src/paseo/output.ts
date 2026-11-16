/**
 * Structured step results (D12, FR17) — the Paseo-facing half.
 *
 * The compiler/validator/parser itself lives in `../executor/output.js`, because the `hc` adapter
 * needs exactly the same contract without importing `src/paseo` (`src/hc` and `src/paseo` stay
 * independent: see `test/hc/isolation.test.ts`). This module re-exports it unchanged, so every
 * Paseo import (`buildStepOutputSchema`, `parseStepResult`, `extractJsonResult`,
 * `validateStepOutput`, and their types) and every Paseo behaviour stay byte-identical, and keeps
 * the one genuinely Paseo-specific thing: what the manual `outputSchema` probe observed per
 * provider.
 */

export * from "../executor/output.js";

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
