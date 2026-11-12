/**
 * The panel's RPC bridge (server side). Every handler calls the same `ArgosRpc` the chat tools use,
 * so there is one connection, one token, and everything runs on the daemon host beside
 * `argos serve`. Errors become result envelopes with the stable Argos code intact.
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";

import { PluginRpcError, type ArgosRpc } from "../shared/rpc-client";
import type { PluginResult } from "../shared/rpc-api";
import {
  GateDecideRpc,
  RunCancelRpc,
  RunGetRpc,
  RunRemoveRpc,
  RunRetryRpc,
  RunStartRpc,
  RunsListRpc,
} from "../shared/rpc-api";

async function wrap<T>(run: () => Promise<T>): Promise<PluginResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    const mapped = PluginRpcError.from(error);
    return {
      ok: false,
      error: { code: mapped.code, message: mapped.message, status: mapped.status },
    };
  }
}

/** Register `argos.runs.*` (list/get/start/cancel/remove/retry) and `argos.gates.decide`; returns nothing (Paseo owns the lifetime). */
export function registerArgosRpc(server: PluginServerContext, client: ArgosRpc): void {
  server.handle(RunsListRpc, () => wrap(() => client.listRuns()));
  server.handle(RunGetRpc, ({ runId }) => wrap(() => client.getRun(runId)));
  server.handle(RunStartRpc, (input) => wrap(() => client.startRun(input)));
  server.handle(RunCancelRpc, ({ runId }) => wrap(() => client.cancelRun(runId)));
  server.handle(RunRemoveRpc, ({ runId }) => wrap(() => client.removeRun(runId)));
  server.handle(RunRetryRpc, ({ runId, stepId }) => wrap(() => client.retryStep(runId, stepId)));
  server.handle(GateDecideRpc, ({ runId, gateId, ...body }) =>
    wrap(() => client.decideGate(runId, gateId, body)),
  );
}
