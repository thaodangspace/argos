/**
 * The plugin's **server** connection resolver (Node-only): `ARGOS_HOME`/`ARGOS_PORT` and the
 * bearer token written by `argos serve` (FR27, D2). Kept out of `shared/` because the client
 * bundle runs in Paseo and cannot read files; the client asks for these values through the
 * `argos.connection` plugin RPC instead.
 *
 * Resolution is lazy: Paseo may start (and load this plugin) before `argos serve` has created
 * `$ARGOS_HOME/token`. Loading must not fail in that case; the first tool call reports the
 * actionable "start it with `argos serve`" error instead.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ARGOS_SERVER_CLOSED,
  createArgosClient,
  PluginRpcError,
  type ArgosRpc,
} from "../shared/rpc-client";
/** Loopback URL + bearer token for the tools client. */
export interface ArgosConnection {
  readonly url: string;
  readonly token: string;
}

const DEFAULT_PORT = 7676;

/** Resolve the loopback URL and token exactly as the CLI does (D2/FR27). */
export function resolveArgosConnection(env: NodeJS.ProcessEnv = process.env): ArgosConnection {
  const home = env["ARGOS_HOME"] ?? join(homedir(), ".argos");
  const rawPort = env["ARGOS_PORT"];
  const parsed = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
  let token: string;
  try {
    token = readFileSync(join(home, "token"), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PluginRpcError(
        "unauthorized",
        `no Argos token at ${home}/token; start the server with \`argos serve\``,
        401,
      );
    }
    throw error;
  }
  if (token === "") {
    throw new PluginRpcError(
      "unauthorized",
      `the Argos token at ${home}/token is empty; restart \`argos serve\``,
      401,
    );
  }
  return { url: `http://127.0.0.1:${String(port)}`, token };
}

/** Build a real client once URL + token are known. */
function connect(): ArgosRpc {
  return createArgosClient(resolveArgosConnection());
}

/**
 * The client used by the chat tools: it resolves the connection on first use, so a plugin reload
 * before `argos serve` exists still loads and the tools return the actionable error.
 */
export function createServerArgosClient(): ArgosRpc {
  let inner: ArgosRpc | undefined;
  let closed = false;
  const get = (): ArgosRpc => {
    if (closed) {
      throw new PluginRpcError(ARGOS_SERVER_CLOSED, "the Argos client is closed", 0);
    }
    inner ??= connect();
    return inner;
  };
  return {
    get url(): string {
      return get().url;
    },
    get closed(): boolean {
      return closed || (inner?.closed ?? false);
    },
    listRuns: () => get().listRuns(),
    getRun: (runId) => get().getRun(runId),
    listGates: () => get().listGates(),
    decideGate: (runId, gateId, body) => get().decideGate(runId, gateId, body),
    startRun: (body) => get().startRun(body),
    cancelRun: (runId) => get().cancelRun(runId),
    removeRun: (runId) => get().removeRun(runId),
    retryStep: (runId, stepId) => get().retryStep(runId, stepId),
    openEvents: (handlers) => get().openEvents(handlers),
    close: () => {
      closed = true;
      inner?.close();
    },
  };
}
