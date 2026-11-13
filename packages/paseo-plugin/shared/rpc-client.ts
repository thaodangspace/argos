/**
 * The plugin's HTTP client for `argos serve` (FR28, D2).
 *
 * This module is deliberately **portable**: it runs in the daemon (server tools) and in the Paseo
 * client (panel), so it imports no Node builtins and reads no files. The caller supplies the base
 * URL and bearer token: `server/connection.ts` resolves them from the environment/token file, and
 * `index.client.tsx` asks the plugin's own server RPC for them. The plugin never opens SQLite and
 * keeps no run state, which is what lets a reload leave a run alive (FR29).
 *
 * Two behaviours are load-bearing:
 *
 * 1. **One typed error.** Every failure — connection refused, a 422 from the loader, a closed
 *    client — surfaces as {@link PluginRpcError} with a stable `code`, so the tools and the panel
 *    render "Argos server not running" instead of a stack trace.
 * 2. **One event stream.** {@link ArgosRpc.openEvents} is the SSE consumer the panel subscribes
 *    to; `close()` aborts it. The server is the source of truth; the plugin keeps no state machine.
 */

import type {
  CancelRunResponse,
  RemoveRunResponse,
  DecideGateRequest,
  GateDecisionResponse,
  GateSummary,
  RunDetail,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from "@thaodangspace/argos-core/rpc/contracts";

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

  /** Normalize anything thrown by this client into one typed plugin error. */
  static from(error: unknown): PluginRpcError {
    if (error instanceof PluginRpcError) return error;
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
 * The whole RPC surface the plugin uses (FR28). Deliberately smaller than the CLI client: no
 * info/doctor, no raw request. `listGates` is the pending-gate projection of `listRuns`.
 */
export interface ArgosRpc {
  readonly url: string;
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
  /** Delete a finished run (`DELETE /runs/:id`); a live run is refused with `run_terminal`. */
  removeRun(runId: string): Promise<RemoveRunResponse>;
  /** Reset `stepId` and everything downstream of it in a finished run, then resume the run. */
  retryStep(runId: string, stepId: string): Promise<StartRunResponse>;
  openEvents: OpenEvents;
  /** Abort every event stream and refuse further calls. Safe to call twice. */
  close(): void;
}

/** What the panel needs; a mocked object with these members satisfies it. */
export type PanelRpc = Pick<ArgosRpc, "listRuns" | "getRun" | "decideGate" | "openEvents"> & {
  readonly cancelRun?: (runId: string) => Promise<unknown>;
  readonly removeRun?: (runId: string) => Promise<unknown>;
  readonly retryStep?: (runId: string, stepId: string) => Promise<unknown>;
  readonly startRun?: (body: StartRunRequest) => Promise<StartRunResponse>;
  readonly close?: () => void;
};

export interface CreateArgosClientOptions {
  /** Base URL of `argos serve`, e.g. `http://127.0.0.1:7676`. */
  readonly url: string;
  /** Bearer token from `$ARGOS_HOME/token`. */
  readonly token: string;
  /** Injectable fetch (tests). */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-request timeout; default 30 s. */
  readonly timeoutMs?: number;
}

interface ErrorEnvelope {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function errorFrom(status: number, body: unknown): PluginRpcError {
  const envelope = body as ErrorEnvelope | undefined;
  const code =
    typeof envelope?.error?.code === "string"
      ? envelope.error.code
      : status === 401
        ? "unauthorized"
        : "internal_error";
  const message =
    typeof envelope?.error?.message === "string"
      ? envelope.error.message
      : `the Argos server answered HTTP ${status}`;
  return new PluginRpcError(code, message, status);
}

/**
 * Create the plugin's RPC client. The caller resolves the URL and token once, when the plugin is
 * loaded: a reload is a new client (D2 — there is no discovery protocol in v1).
 */
export function createArgosClient(options: CreateArgosClientOptions): ArgosRpc {
  const url = options.url.replace(/\/+$/, "");
  const token = options.token;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const streams = new Set<{ readonly controller: AbortController }>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new PluginRpcError(ARGOS_SERVER_CLOSED, "the Argos client is closed", 0);
    }
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    assertOpen();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetchImpl(`${url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) throw errorFrom(response.status, parsed);
      return parsed as T;
    } catch (error) {
      if (error instanceof PluginRpcError) throw error;
      if (controller.signal.aborted && !closed) {
        throw new PluginRpcError(ARGOS_SERVER_UNREACHABLE, ARGOS_NOT_RUNNING_MESSAGE, 0);
      }
      throw new PluginRpcError(
        closed ? ARGOS_SERVER_CLOSED : ARGOS_SERVER_UNREACHABLE,
        closed ? "the Argos client is closed" : ARGOS_NOT_RUNNING_MESSAGE,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const openEvents: OpenEvents = (handlers) => {
    assertOpen();
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

  return {
    url,
    get closed(): boolean {
      return closed;
    },
    listRuns: async () => (await request<{ runs: RunSummary[] }>("GET", "/runs")).runs,
    getRun: (runId) => request<RunDetail>("GET", `/runs/${encodeURIComponent(runId)}`),
    listGates: async () => {
      const { runs } = await request<{ runs: RunSummary[] }>("GET", "/runs");
      return runs.flatMap((run) => run.gates.filter((gate) => gate.status === "pending"));
    },
    decideGate: (runId, gateId, body) =>
      request<GateDecisionResponse>(
        "POST",
        `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}`,
        body,
      ),
    startRun: (body) => request<StartRunResponse>("POST", "/runs", body),
    cancelRun: (runId) =>
      request<CancelRunResponse>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {}),
    removeRun: (runId) =>
      request<RemoveRunResponse>("DELETE", `/runs/${encodeURIComponent(runId)}`),
    retryStep: (runId, stepId) =>
      request<StartRunResponse>("POST", `/runs/${encodeURIComponent(runId)}/retry`, { stepId }),
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
