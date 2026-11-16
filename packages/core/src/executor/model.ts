/**
 * The executor model (FR1, FR2): the canonical substrate ids, one normalizer, and the zod schema
 * every surface shares.
 *
 * This module imports **only** `zod` and the error type, exactly like `schedule/model.ts`: the CLI,
 * the Paseo plugin (through `rpc/contracts.ts`), and the durable host must agree on one normalizer,
 * and the plugin bundles the RPC contract but must never load a durable layer or an adapter.
 *
 * `paseo` is the default and the only id a run record may omit (FR5); `hc` is herdr-core.
 */

import { z } from "zod";

import { ArgosError } from "../errors.js";

// ------------------------------------------------------------------ ids

/** FR1: the canonical executor ids. Only these are ever stored or rendered. */
export const EXECUTOR_IDS = ["paseo", "hc"] as const;
export type ExecutorId = (typeof EXECUTOR_IDS)[number];

/** FR5: the default substrate; a run record omits `executor` when it is this one. */
export const DEFAULT_EXECUTOR_ID: ExecutorId = "paseo";

/** The canonical id, as stored in a run record and in every read model (FR5, FR8). */
export const ExecutorIdSchema = z.enum(EXECUTOR_IDS);

// ------------------------------------------------------------------ normalization

/**
 * FR1: every spelling a caller may send. Matching is trimmed and case-insensitive, so `Herdr`,
 * ` herdr-core `, and `hc` all mean `hc`, and `paseo` stays `paseo`.
 */
const EXECUTOR_ALIASES: Readonly<Record<string, ExecutorId>> = {
  paseo: "paseo",
  hc: "hc",
  herdr: "hc",
  "herdr-core": "hc",
};

// ------------------------------------------------------------------ info (FR9)

/**
 * FR9: what an executor can do, as `GET /info` and `argos doctor` publish it.
 *
 * The four flags are deliberately coarse — a UI or an operator reads them, nothing branches on them
 * in the control path:
 *
 * - `structuredOutput`: the adapter can hand back a schema-validated result (Paseo's
 *   `outputSchema`); `false` means a playbook that declares `outputs` relies on the fenced-JSON
 *   fallback only.
 * - `quota`: the substrate reports provider quota, so a usage-limit hit becomes a target hop
 *   (`provider_exhausted` when every target is blocked).
 * - `interactiveBlocked`: the substrate can park a step on a human answer instead of finishing, so
 *   the step deadline is what ends it.
 * - `scheduleSafe`: the substrate can run unattended (no prompt, no terminal attached).
 */
export const ExecutorCapabilitiesSchema = z.strictObject({
  structuredOutput: z.boolean(),
  quota: z.boolean(),
  interactiveBlocked: z.boolean(),
  scheduleSafe: z.boolean(),
});
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilitiesSchema>;

/**
 * FR9: one registered executor, with its identity, reachability, and capabilities.
 *
 * `default` marks the substrate a run without an override starts on. `error` carries the adapter's
 * own message when `reachable` is false (never a credential — the adapters redact).
 */
export const ExecutorInfoSchema = z.strictObject({
  id: ExecutorIdSchema,
  default: z.boolean(),
  reachable: z.boolean(),
  version: z.string().min(1).optional(),
  capabilities: ExecutorCapabilitiesSchema,
  error: z.string().optional(),
});
export type ExecutorInfo = z.infer<typeof ExecutorInfoSchema>;

/**
 * FR9: the documented capability default per substrate, used when the host was opened without a
 * descriptor for that id (and as the base a descriptor overrides).
 *
 * Paseo: native structured output, provider quota, one-shot agents (nothing to answer), safe under
 * a schedule. `hc` (herdr-core): terminals, so declared outputs go through the fenced-JSON
 * fallback, no provider counters, an agent can ask for input (`blocked`), and a schedule is as safe
 * as the step deadline — its terminal program must report status to finish early.
 */
export const DEFAULT_EXECUTOR_CAPABILITIES: Readonly<Record<ExecutorId, ExecutorCapabilities>> = {
  paseo: {
    structuredOutput: true,
    quota: true,
    interactiveBlocked: false,
    scheduleSafe: true,
  },
  hc: {
    structuredOutput: false,
    quota: false,
    interactiveBlocked: true,
    scheduleSafe: true,
  },
};

/**
 * FR1: the canonical id for a supplied value, or `undefined` when it is not an executor at all.
 *
 * Callers that own the error code use this: the durable host answers `executor_unavailable`
 * (`nope` is just as unregistered as a known id whose adapter is missing, FR6), while
 * {@link normalizeExecutorId} is the caller-facing validation gate.
 */
export function executorIdFor(value: string): ExecutorId | undefined {
  return EXECUTOR_ALIASES[value.trim().toLowerCase()];
}

/**
 * FR1/FR3: normalize a caller's executor value to the canonical id. An unknown value is
 * `invalid_request` — the CLI/RPC refusal, raised before any request reaches the host.
 */
export function normalizeExecutorId(value: string): ExecutorId {
  const id = executorIdFor(value);
  if (id === undefined) {
    throw new ArgosError(
      "invalid_request",
      `executor ${JSON.stringify(value)} is unknown: use one of ${EXECUTOR_IDS.join(", ")}`,
    );
  }
  return id;
}
