/**
 * The plugin's **server** connection resolver (Node-only): `ARGOS_HOME`/`ARGOS_PORT` and the
 * bearer token written by `argos serve` (FR27, D2). Kept out of `shared/` because the client
 * bundle runs in Paseo and cannot read files; the client asks for these values through the
 * `argos.connection` plugin RPC instead.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createArgosClient, type ArgosRpc } from "../shared/rpc-client";
import type { ArgosConnection } from "../shared/connection";

const DEFAULT_PORT = 7676;

/** Resolve the loopback URL and token exactly as the CLI does (D2/FR27). */
export function resolveArgosConnection(env: NodeJS.ProcessEnv = process.env): ArgosConnection {
  const home = env["ARGOS_HOME"] ?? join(homedir(), ".argos");
  const rawPort = env["ARGOS_PORT"];
  const parsed = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return { url: `http://127.0.0.1:${String(port)}`, token };
}

/** The client used by the chat tools, created once per plugin instance. */
export function createServerArgosClient(): ArgosRpc {
  return createArgosClient(resolveArgosConnection());
}
