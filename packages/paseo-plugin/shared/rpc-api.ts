/**
 * Plugin RPC surface used by the panel (FR28).
 *
 * The panel runs in the Paseo client (browser/React Native), often on a different machine than the
 * daemon, and cannot read `$ARGOS_HOME/token`. It therefore never talks to `argos serve` directly:
 * every read/decision goes through the plugin's **server** half, which runs beside `argos serve`
 * and calls `127.0.0.1`. That also sidesteps browser CORS and works across remote hosts.
 *
 * Each call returns a result envelope instead of throwing, so stable Argos codes
 * (`gate_already_decided`, `playbook_invalid`, …) survive the Paseo RPC boundary.
 */

import { z } from "zod";
import type { PluginRpcContract } from "@getpaseo/plugin";

import {
  CancelRunResponseSchema,
  DecideGateRequestSchema,
  GateDecisionResponseSchema,
  RemoveRunResponseSchema,
  RunDetailSchema,
  RunSummarySchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from "@thaodangspace/argos-core/rpc/contracts";

export const PluginErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  status: z.number().int(),
});

const failure = z.strictObject({
  ok: z.literal(false),
  error: PluginErrorSchema,
});

function result<T extends z.ZodType>(data: T) {
  return z.union([z.strictObject({ ok: z.literal(true), data }), failure]);
}

export type PluginResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: z.output<typeof PluginErrorSchema> };

const EmptyInput = z.strictObject({});

/** `argos.runs.list` -> `RunSummary[]` (the same projection as `GET /runs`, no prompts). */
export const RunsListRpc = {
  name: "argos.runs.list",
  input: EmptyInput,
  output: result(z.array(RunSummarySchema)),
} satisfies PluginRpcContract;

/** `argos.runs.get` -> `RunDetail` (bounded history + gate documents). */
export const RunGetRpc = {
  name: "argos.runs.get",
  input: z.strictObject({ runId: z.string() }),
  output: result(RunDetailSchema),
} satisfies PluginRpcContract;

/** `argos.runs.start` -> the `POST /runs` response (chat tools use HTTP directly). */
export const RunStartRpc = {
  name: "argos.runs.start",
  input: StartRunRequestSchema,
  output: result(StartRunResponseSchema),
} satisfies PluginRpcContract;

/** `argos.runs.cancel` -> `POST /runs/:id/cancel`. */
export const RunCancelRpc = {
  name: "argos.runs.cancel",
  input: z.strictObject({ runId: z.string() }),
  output: result(CancelRunResponseSchema),
} satisfies PluginRpcContract;

/** `argos.runs.remove` -> `DELETE /runs/:id`: delete a finished run (its worktree is kept). */
export const RunRemoveRpc = {
  name: "argos.runs.remove",
  input: z.strictObject({ runId: z.string() }),
  output: result(RemoveRunResponseSchema),
} satisfies PluginRpcContract;

/** `argos.runs.retry` -> `POST /runs/:id/retry`: reset a step and its downstream in a finished run. */
export const RunRetryRpc = {
  name: "argos.runs.retry",
  input: z.strictObject({ runId: z.string(), stepId: z.string() }),
  output: result(StartRunResponseSchema),
} satisfies PluginRpcContract;

/** `argos.gates.decide` -> `POST /runs/:id/gates/:gateId`, first writer wins. */
export const GateDecideRpc = {
  name: "argos.gates.decide",
  input: DecideGateRequestSchema.extend({
    runId: z.string(),
    gateId: z.string(),
  }),
  output: result(GateDecisionResponseSchema),
} satisfies PluginRpcContract;

/** All contracts the server registers; tests assert the exact names. */
export const PLUGIN_RPC_CONTRACTS = [
  RunsListRpc,
  RunGetRpc,
  RunStartRpc,
  RunCancelRpc,
  RunRemoveRpc,
  RunRetryRpc,
  GateDecideRpc,
] as const;
