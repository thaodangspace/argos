/**
 * The server-side plugin runtime (FR28): one RPC client, four tools, one lifecycle hook.
 *
 * `index.server.ts` default-exports {@link createArgosContribution} with no options; tests pass a
 * client factory so they can spy on `close()`. The teardown is intentionally small — it removes
 * the hook(s), aborts the SSE/HTTP work, and closes **only** the HTTP client. The plugin never
 * opened a database, so there is nothing else to close.
 */

import type {
  AgentToolDefinition,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import type { PluginCleanup } from "@getpaseo/plugin";

import type { ArgosRpc } from "../shared/rpc-client";
import { ConnectionRpc } from "../shared/connection";
import { createServerArgosClient, resolveArgosConnection } from "./connection";
import { appendArgosTools, argosTools } from "./tools";

/** Name of the one hook the plugin registers. */
export const AGENT_OPEN_HOOK = "agent.open.before" as const;

export interface ArgosRuntime {
  readonly client: ArgosRpc;
  readonly tools: AgentToolDefinition[];
  /** Idempotent: closes the HTTP client (which aborts every event stream). */
  close(): Promise<void>;
}

/** One plugin instance: its client, its tools, and nothing else. */
export function createArgosRuntime(options: { readonly client?: ArgosRpc } = {}): ArgosRuntime {
  const client = options.client ?? createServerArgosClient();
  const tools = argosTools(client);
  let closed = false;
  return {
    client,
    tools,
    close: async () => {
      if (closed) return;
      closed = true;
      client.close();
    },
  };
}

/**
 * Add the Argos tools to a session-open request. Exported for the contribute test: the hook
 * handler is the whole integration point, so it can be exercised without a daemon.
 */
export function withArgosTools(
  request: PluginSessionOpenRequest,
  tools: readonly AgentToolDefinition[],
): PluginSessionOpenRequest {
  return { ...request, tools: appendArgosTools(request.tools, tools) };
}

export interface ArgosContributionOptions {
  /** Test seam: a spy client instead of `createArgosClient()`. Called once per `contribute`. */
  readonly createClient?: () => ArgosRpc;
}

/**
 * Build the `contribute(server)` function. Each invocation creates one runtime, registers the
 * `agent.open.before` hook, and returns a teardown that removes that hook and closes the client.
 * Nothing is registered globally, so a reload starts from a clean slate.
 */
export function createArgosContribution(
  options: ArgosContributionOptions = {},
): (server: PluginServerContext) => PluginCleanup {
  return (server: PluginServerContext): PluginCleanup => {
    const runtime = createArgosRuntime(
      options.createClient === undefined ? {} : { client: options.createClient() },
    );
    const removeHook = server.addHook(AGENT_OPEN_HOOK, async ({ request }) =>
      withArgosTools(request, runtime.tools),
    );
    // The panel runs in the Paseo client bundle, which cannot read `$ARGOS_HOME/token`; this one
    // handler hands it the loopback URL + token. The chat tools call `argos serve` directly.
    server.handle(ConnectionRpc, () => resolveArgosConnection());
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      removeHook();
      await runtime.close();
    };
  };
}
