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
