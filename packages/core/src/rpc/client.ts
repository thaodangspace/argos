/**
 * Typed HTTP client for `argos serve` (FR3, FR25).
 *
 * One process — `argos serve` — owns SQLite. The CLI, the Paseo plugin, and tests use this client
 * and nothing else: it imports no durable module and never opens a database. The bearer token is
 * read from `$ARGOS_HOME/token` (FR27); the port from `ARGOS_PORT` (D2).
 *
 * An `RpcClientError` carries the stable `code` from the server's {@link ErrorResponse}, the HTTP
 * `status` (0 for "never reached the server"), and the message unchanged, so a CLI can print an
 * actionable line and map the failure to its exit code without re-parsing prose.
 */

import { readFileSync } from "node:fs";

import {
  DEFAULT_ARGOS_PORT,
  type CancelRunResponse,
  type DecideGateRequest,
  type GateDecisionResponse,
  type GateListResponse,
  type RunDetail,
  type RunListResponse,
  type ServerInfo,
  type StartRunRequest,
  type StartRunResponse,
} from "./contracts.js";
import { argosHome, tokenPath } from "../paths.js";

/** A failed RPC call: either a typed server error or a transport failure (`status: 0`). */
export class RpcClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** The server was never reached (connection refused, DNS, timeout). */
  get unreachable(): boolean {
    return this.status === 0;
  }

  /** Missing or rejected credentials. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403 || this.code === "unauthorized";
  }
}

export interface RpcClientOptions {
  /** `ARGOS_HOME` override; default {@link argosHome}. */
  readonly home?: string;
  /** `ARGOS_PORT` override; default 7676. Ignored when `url` is set. */
  readonly port?: number;
  /** Full base URL (`http://127.0.0.1:7676`); wins over `port`. */
  readonly url?: string;
  /** Bearer token; default: read `$ARGOS_HOME/token`. */
  readonly token?: string;
  /** Injectable fetch (tests); default the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-request timeout; default 30 s. */
  readonly timeoutMs?: number;
}

/**
 * Build a client for `argos serve`. The CLI, the Paseo plugin, and tests all go through this
 * factory instead of `new RpcClient(...)` so the `ARGOS_PORT` / `$ARGOS_HOME/token` defaults (D2,
 * FR27) live in exactly one place.
 */
export function createRpcClient(options: RpcClientOptions = {}): RpcClient {
  return new RpcClient(options);
}

/** The token file's content, or `undefined` when it does not exist yet. */
export function readTokenFile(home: string = argosHome()): string | undefined {
  try {
    const value = readFileSync(tokenPath(home), "utf8").trim();
    return value === "" ? undefined : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** `http://127.0.0.1:<port>` from `ARGOS_PORT`, default 7676 (D2). */
export function defaultBaseUrl(): string {
  const raw = process.env["ARGOS_PORT"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const port = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ARGOS_PORT;
  return `http://127.0.0.1:${port}`;
}

export class RpcClient {
  readonly #home: string;
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: RpcClientOptions = {}) {
    this.#home = options.home ?? argosHome();
    this.#baseUrl = (options.url ?? defaultBaseUrl()).replace(/\/+$/, "");
    this.#token = options.token ?? readTokenFile(this.#home);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get home(): string {
    return this.#home;
  }

  /** `GET /health`. */
  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>("GET", "/health");
  }

  /** `GET /info` (`argos doctor`). */
  async info(): Promise<ServerInfo> {
    return this.request<ServerInfo>("GET", "/info");
  }

  /** `POST /runs`. */
  async startRun(body: StartRunRequest): Promise<StartRunResponse> {
    return this.request<StartRunResponse>("POST", "/runs", body);
  }

  /** `GET /runs`. */
  async listRuns(): Promise<RunListResponse> {
    return this.request<RunListResponse>("GET", "/runs");
  }

  /** `GET /runs/:id`. */
  async getRun(runId: string): Promise<RunDetail> {
    return this.request<RunDetail>("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  /** `POST /runs/:id/cancel`. */
  async cancelRun(runId: string): Promise<CancelRunResponse> {
    return this.request<CancelRunResponse>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  /** `POST /runs/:id/retry`. */
  async retryStep(runId: string, stepId: string): Promise<StartRunResponse> {
    return this.request<StartRunResponse>("POST", `/runs/${encodeURIComponent(runId)}/retry`, {
      stepId,
    });
  }

  /** `POST /runs/:id/gates/:gateId`. */
  async decideGate(
    runId: string,
    gateId: string,
    body: DecideGateRequest,
  ): Promise<GateDecisionResponse> {
    return this.request<GateDecisionResponse>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}`,
      body,
    );
  }

  /** `GET /runs` filtered to pending gates (the `argos gates` shape). */
  async listPendingGates(): Promise<GateListResponse> {
    const { runs } = await this.listRuns();
    return {
      gates: runs.flatMap((run) => run.gates.filter((gate) => gate.status === "pending")),
    };
  }

  /** A `DoctorReport` is composed by the CLI from {@link info} plus local path checks. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#token === undefined) {
      throw new RpcClientError(
        "unauthorized",
        `no token at ${tokenPath(this.#home)}; start the server with \`argos serve\``,
        401,
      );
    }
    headers["authorization"] = `Bearer ${this.#token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new RpcClientError(
        "unreachable",
        `cannot reach the argos server at ${this.#baseUrl}: ${cause}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.trim() === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new RpcClientError(
        "internal_error",
        `the argos server returned a non-JSON response (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } })
        ?.error;
      const code = typeof error?.code === "string" ? error.code : "internal_error";
      const message =
        typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      const details =
        typeof error?.details === "object" && error.details !== null
          ? (error.details as Readonly<Record<string, unknown>>)
          : undefined;
      throw new RpcClientError(code, message, response.status, details);
    }
    return payload as T;
  }
}
