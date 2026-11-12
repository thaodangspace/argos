/**
 * `index.server.ts` — the server half of the Argos Paseo plugin (FR28).
 *
 * The plugin is a thin RPC client of `argos serve`: it opens no SQLite, runs no timers, and keeps
 * no run state. Installing it adds four chat tools to every agent session; reloading it is safe
 * because the runs live in the server process (FR29), not here.
 */

import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createArgosContribution } from "./server/plugin";

export {
  AGENT_OPEN_HOOK,
  createArgosContribution,
  createArgosRuntime,
  withArgosTools,
  type ArgosContributionOptions,
  type ArgosRuntime,
} from "./server/plugin";
export {
  ARGOS_TOOL_NAMES,
  appendArgosTools,
  argosTools,
  type ArgosToolName,
} from "./server/tools";
export {
  ARGOS_NOT_RUNNING_MESSAGE,
  ARGOS_SERVER_CLOSED,
  ARGOS_SERVER_UNREACHABLE,
  createArgosClient,
  PluginRpcError,
  type ArgosRpc,
} from "./shared/rpc-client";

const contribute = createArgosContribution();

export default function (server: PluginServerContext) {
  return contribute(server);
}
