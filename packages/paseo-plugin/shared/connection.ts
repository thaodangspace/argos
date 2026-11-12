/**
 * Shared plugin RPC contract: the panel asks the plugin's **server** half for the Argos connection
 * (loopback URL + bearer token). The Paseo client bundle cannot read `$ARGOS_HOME/token`, so this
 * one call is how a thin panel gets credentials without weakening the server's token auth (FR27).
 */

import { z } from "zod";
import type { PluginRpcContract } from "@getpaseo/plugin";

export const ARGOS_CONNECTION_RPC = "argos.connection";

export const ConnectionInputSchema = z.object({});
export const ConnectionOutputSchema = z.object({
  url: z.string(),
  token: z.string(),
});

/** `argos.connection` — server handler in `server/plugin.ts`, client call in `index.client.tsx`. */
export const ConnectionRpc: PluginRpcContract<
  typeof ConnectionInputSchema,
  typeof ConnectionOutputSchema
> = {
  name: ARGOS_CONNECTION_RPC,
  input: ConnectionInputSchema,
  output: ConnectionOutputSchema,
};

export type ArgosConnection = z.output<typeof ConnectionOutputSchema>;
