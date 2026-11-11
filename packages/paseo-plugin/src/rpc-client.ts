/**
 * The plugin's HTTP client for `argos serve` (FR28, D2).
 *
 * This is the **only** module that opens a connection, and it opens exactly one kind: HTTP to the
 * loopback RPC server. It never imports `argos-core/durable`, `argos-core/git`, `argos-core/paseo`,
 * `@earendil-works/*`, `node:sqlite`, or `node:fs` (the token is read by `argos-core/rpc`, which
 * owns the `$ARGOS_HOME/token` convention). That is what lets a plugin reload leave a run alive:
 * the plugin has no durable state to lose.
 *
 * Two behaviours are load-bearing:
 *
 * 1. **One typed error.** Every failure — connection refused, a 422 from the loader, a closed
 *    client — surfaces as {@link PluginRpcError} with a stable `code`, so the tools and the panel
 *    render "Argos server not running" instead of a stack trace.
 * 2. **One event stream.** {@link ArgosRpc.openEvents} is the SSE consumer the panel subscribes
 *    to; `close()` aborts it. The server is the source of truth; the plugin keeps no state machine.
 */

import {
  createRpcClient,
  readTokenFile,
  RpcClientError,
  type CancelRunResponse,
  type DecideGateRequest,
  type GateDecisionResponse,
  type GateSummary,
  type RunDetail,
  type RunSummary,
  type StartRunRequest,
  type StartRunResponse,
} from "argos-core/rpc";

/** Connection refused / no server listening: rendered as "Argos server not running". */
export const ARGOS_SERVER_UNREACHABLE = "argos_server_unreachable";
/** The client was closed (plugin teardown); no further HTTP work is allowed. */
export const ARGOS_SERVER_CLOSED = "argos_server_closed";

/** The one line the panel and the tools show for a stopped server. */
export const ARGOS_NOT_RUNNING_MESSAGE =
  "Argos server not running (start it with `argos serve`)";

/**
 * A plugin-local RPC failure. `code` is the server's stable code when one exists
 * (`playbook_invalid`, `gate_already_decided`, …) and a plugin code otherwise
 * ({@link ARGOS_SERVER_UNREACHABLE}, {@link ARGOS_SERVER_CLOSED}).
 */
export class PluginRpcError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "PluginRpcError";
    this.code = code;
    this.status = status;
  }

  /** No server was reached (or the client is closed): show the "not running" line. */
  get unreachable(): boolean {
    return this.code === ARGOS_SERVER_UNREACHABLE || this.code === ARGOS_SERVER_CLOSED;
  }

  /** Normalize anything thrown by the contract client into one typed plugin error. */
  static from(error: unknown): PluginRpcError {
    if (error instanceof PluginRpcError) return error;
    if (error instanceof RpcClientError) {
      if (error.unreachable) {
        return new PluginRpcError(ARGOS_SERVER_UNREACHABLE, ARGOS_NOT_RUNNING_MESSAGE, 0);
      }
      return new PluginRpcError(error.code, error.message, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new PluginRpcError("internal_error", message, 0);
  }
}

// ------------------------------------------------------------------ SSE

/** One `event:`/`data:` pair from `GET /events`. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface SseHandlers {
  onFrame(frame: SseFrame): void;
  onOpen?(): void;
  onError?(error: PluginRpcError): void;
}

/** A live event stream. `close()` aborts the underlying fetch. */
export interface EventStreamHandle {
  close(): void;
}

/** Injectable stream opener: tests pass a fake, production opens `GET /events`. */
export type OpenEvents = (handlers: SseHandlers) => EventStreamHandle;

/** Parse one SSE block (the text between two blank lines). Comments (`: ping`) yield `undefined`. */
export function parseSseBlock(block: string): SseFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}

// ------------------------------------------------------------------ surface

/**
 * The whole RPC surface the plugin uses (FR28). Deliberately smaller than `RpcClient`: no retry,
 * no info/doctor, no raw request. `listGates` is the pending-gate projection of `listRuns`.
 */
export interface ArgosRpc {
  readonly url: string;
  readonly home: string;
  readonly closed: boolean;
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunDetail>;
  listGates(): Promise<GateSummary[]>;
  decideGate(
    runId: string,
    gateId: string,
    body: DecideGateRequest,
  ): Promise<GateDecisionResponse>;
  startRun(body: StartRunRequest): Promise<StartRunResponse>;
  cancelRun(runId: string): Promise<CancelRunResponse>;
  openEvents: OpenEvents;
  /** Abort every event stream and refuse further calls. Safe to call twice. */
  close(): void;
}

/** What the panel needs; a mocked object with these members satisfies it. */
export type PanelRpc = Pick<ArgosRpc, "listRuns" | "decideGate" | "openEvents"> & {
  readonly cancelRun?: (runId: string) => Promise<unknown>;
  readonly close?: () => void;
};

export interface CreateArgosClientOptions {
  /** `$ARGOS_HOME` override (the token lives here); default `ARGOS_HOME` / `~/.argos`. */
  readonly home?: string;
  /** `ARGOS_PORT` override; default 7676 (D2). */
  readonly port?: number;
  /** Full base URL; wins over `port`. */
  readonly url?: string;
  /** Bearer token override; default `$ARGOS_HOME/token`. */
  readonly token?: string;
  /** Injectable fetch (tests). */
  readonly fetch?: typeof globalThis.fetch;
}

function tokenMessage(home: string): string {
  return `no Argos token at ${home}/token; start the server with \`argos serve\``;
}

/**
 * Create the plugin's RPC client. `ARGOS_PORT` and the token file are resolved once, when the
 * plugin is loaded: a reload is a new client (D2 — there is no discovery protocol in v1).
 */
export function createArgosClient(options: CreateArgosClientOptions = {}): ArgosRpc {
  const rpc = createRpcClient({
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const url = rpc.baseUrl;
  const home = rpc.home;
  const token = options.token ?? readTokenFile(home);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams = new Set<{ readonly controller: AbortController }>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new PluginRpcError(ARGOS_SERVER_CLOSED, "the Argos client is closed", 0);
    }
  };

  const openEvents: OpenEvents = (handlers) => {
    assertOpen();
    if (token === undefined) {
      throw new PluginRpcError("unauthorized", tokenMessage(home), 401);
    }
    const controller = new AbortController();
    const entry = { controller };
    streams.add(entry);
    let finished = false;

    const finish = (error?: PluginRpcError): void => {
      if (finished) return;
      finished = true;
      streams.delete(entry);
      if (error !== undefined) handlers.onError?.(error);
    };

    void (async () => {
      try {
        const response = await fetchImpl(`${url}/events`, {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          throw new PluginRpcError(
            response.status === 401 ? "unauthorized" : ARGOS_SERVER_UNREACHABLE,
            response.status === 401
              ? "the Argos server rejected the token"
              : ARGOS_NOT_RUNNING_MESSAGE,
            response.status,
          );
        }
        handlers.onOpen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const index = buffer.indexOf("\n\n");
            if (index === -1) break;
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const frame = parseSseBlock(block);
            if (frame !== undefined) handlers.onFrame(frame);
          }
        }
        finish(
          closed
            ? undefined
            : new PluginRpcError(
                ARGOS_SERVER_UNREACHABLE,
                "the Argos event stream closed",
                0,
              ),
        );
      } catch (error) {
        if (controller.signal.aborted || closed) {
          finish();
          return;
        }
        finish(PluginRpcError.from(error));
      }
    })();

    return {
      close: () => {
        finished = true;
        streams.delete(entry);
        controller.abort();
      },
    };
  };

  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    assertOpen();
    try {
      return await run();
    } catch (error) {
      throw PluginRpcError.from(error);
    }
  };

  return {
    url,
    home,
    get closed(): boolean {
      return closed;
    },
    listRuns: () => call(async () => (await rpc.listRuns()).runs),
    getRun: (runId) => call(() => rpc.getRun(runId)),
    listGates: () =>
      call(async () => (await rpc.listPendingGates()).gates),
    decideGate: (runId, gateId, body) => call(() => rpc.decideGate(runId, gateId, body)),
    startRun: (body) => call(() => rpc.startRun(body)),
    cancelRun: (runId) => call(() => rpc.cancelRun(runId)),
    openEvents,
    close: () => {
      closed = true;
      for (const stream of [...streams]) {
        streams.delete(stream);
        stream.controller.abort();
      }
    },
  };
}
