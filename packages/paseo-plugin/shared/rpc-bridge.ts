/**
 * The panel's `ArgosRpc` implementation over Paseo plugin RPC.
 *
 * The client bundle cannot read the token, cannot rely on CORS, and may not share a machine with
 * the daemon. So instead of HTTP it invokes the plugin's server handlers (which call
 * `127.0.0.1`). The event stream is a 2 s poll of `argos.runs.list`, delivered as the same
 * `snapshot` frames the SSE endpoint uses, so `subscribeRuns`/reconnect logic is unchanged.
 */

import {
  SSE_SNAPSHOT_EVENT,
  type CancelRunResponse,
  type DecideGateRequest,
  type GateDecisionResponse,
  type RunDetail,
  type RunSummary,
  type StartRunRequest,
  type StartRunResponse,
} from "argos-core/rpc/contracts";

import type { PluginResult } from "./rpc-api";
import {
  ARGOS_SERVER_CLOSED,
  ARGOS_SERVER_UNREACHABLE,
  ARGOS_NOT_RUNNING_MESSAGE,
  PluginRpcError,
  type ArgosRpc,
  type EventStreamHandle,
  type OpenEvents,
  type SseHandlers,
} from "./rpc-client";

/** The four RPC call functions, as returned by `useRpc(contract)` in the panel. */
export interface ArgosRpcCalls {
  listRuns(input: Record<string, never>): Promise<PluginResult<RunSummary[]>>;
  getRun(input: { readonly runId: string }): Promise<PluginResult<RunDetail>>;
  startRun(input: StartRunRequest): Promise<PluginResult<StartRunResponse>>;
  cancelRun(input: { readonly runId: string }): Promise<PluginResult<CancelRunResponse>>;
  decideGate(
    input: DecideGateRequest & { readonly runId: string; readonly gateId: string },
  ): Promise<PluginResult<GateDecisionResponse>>;
}

export interface RpcBridgeOptions {
  /** Poll interval for the panel snapshot; default 2000 ms (the gate latency budget). */
  readonly pollMs?: number;
}

function unwrap<T>(result: PluginResult<T>): T {
  if (result.ok) return result.data;
  throw new PluginRpcError(result.error.code, result.error.message, result.error.status);
}

/** The loopback URL is not used: requests go through the plugin RPC channel. */
const BRIDGE_URL = "plugin-rpc://argos";

export function createRpcClientBridge(
  calls: ArgosRpcCalls,
  options: RpcBridgeOptions = {},
): ArgosRpc {
  const pollMs = options.pollMs ?? 2_000;
  const streams = new Set<{ stop(): void }>();
  let closed = false;
  let cachedRuns: RunSummary[] = [];

  const assertOpen = (): void => {
    if (closed) throw new PluginRpcError(ARGOS_SERVER_CLOSED, "the Argos client is closed", 0);
  };

  const openEvents: OpenEvents = (handlers: SseHandlers): EventStreamHandle => {
    assertOpen();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let opened = false;

    const stop = (): void => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const runs = unwrap(await calls.listRuns({}));
        if (stopped) return;
        cachedRuns = runs;
        if (!opened) {
          opened = true;
          handlers.onOpen?.();
        }
        handlers.onFrame({ event: SSE_SNAPSHOT_EVENT, data: JSON.stringify({ runs }) });
        if (!stopped) timer = setTimeout(() => void tick(), pollMs);
      } catch (error) {
        if (stopped) return;
        stop();
        streams.delete(entry);
        const mapped = PluginRpcError.from(error);
        handlers.onError?.(
          mapped.unreachable || mapped.code === "internal_error"
            ? new PluginRpcError(ARGOS_SERVER_UNREACHABLE, ARGOS_NOT_RUNNING_MESSAGE, 0)
            : mapped,
        );
      }
    };

    const entry = { stop };
    streams.add(entry);
    void tick();

    return {
      close: () => {
        stop();
        streams.delete(entry);
      },
    };
  };

  return {
    url: BRIDGE_URL,
    get closed(): boolean {
      return closed;
    },
    listRuns: async () => {
      assertOpen();
      cachedRuns = unwrap(await calls.listRuns({}));
      return cachedRuns;
    },
    getRun: async (runId) => {
      assertOpen();
      return unwrap(await calls.getRun({ runId }));
    },
    listGates: async () =>
      cachedRuns.flatMap((run) => run.gates.filter((gate) => gate.status === "pending")),
    decideGate: async (runId, gateId, body) => {
      assertOpen();
      return unwrap(await calls.decideGate({ runId, gateId, ...body }));
    },
    startRun: async (body) => {
      assertOpen();
      return unwrap(await calls.startRun(body));
    },
    cancelRun: async (runId) => {
      assertOpen();
      return unwrap(await calls.cancelRun({ runId }));
    },
    openEvents,
    close: () => {
      closed = true;
      for (const stream of [...streams]) {
        streams.delete(stream);
        stream.stop();
      }
    },
  };
}
