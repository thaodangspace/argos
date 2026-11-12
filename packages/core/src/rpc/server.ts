/**
 * `argos serve`'s HTTP surface (FR26, FR27, Phase 8).
 *
 * - **Loopback only** (D2): the listener binds `127.0.0.1`; there is no discovery protocol in v1,
 *   the CLI and plugin read `ARGOS_PORT` and `$ARGOS_HOME/token`.
 * - **Token on every request** (FR27): the first `serve` writes a 32-byte hex token with mode
 *   `0600`; every route compares `Authorization: Bearer <token>` in constant time and answers 401
 *   otherwise. The token is never logged.
 * - **One writer** (FR2/FR4): this module is imported only by `argos serve`, which owns the
 *   `ArgosHost`. The server never opens storage itself; it reads the host's mirrored documents.
 * - **SSE is event-driven** (FR26): `GET /events` sends one `snapshot` frame and then one `run`
 *   frame per changed run, pushed from `ArgosHost.observeRuns` (a commit observer). There is no
 *   database polling; only a `: ping` heartbeat runs on a timer.
 *
 * `rpc/index.ts` deliberately does not import this module: `argos-core/rpc` stays free of durable
 * imports for the CLI/plugin, while `argos-core/rpc/server` is the serve-only subpath.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

import { ArgosError, isArgosError } from "../errors.js";
import { loadPlaybook } from "../playbook/index.js";
import type { InputDefIR, IsolationIR, PlaybookIR, Scalar } from "../playbook/ir.js";
import { argosHome, ensureHome, tokenPath, ARGOS_TOKEN_MODE } from "../paths.js";
import { ModelCatalog } from "../paseo/model-catalog.js";
import type { ProviderCatalog } from "../paseo/port.js";
import { ArgosHost, type ArgosHostOptions } from "../durable/host.js";
import {
  ARGOS_RPC_VERSION,
  ARGOS_SCHEMA_VERSION,
  CancelRunResponseSchema,
  DecideGateRequestSchema,
  DEFAULT_ARGOS_PORT,
  GateDecisionResponseSchema,
  RetryRequestSchema,
  RunDetailSchema,
  RunListResponseSchema,
  SSE_RUN_EVENT,
  SSE_SNAPSHOT_EVENT,
  StartRunRequestSchema,
  StartRunResponseSchema,
  statusForCode,
  type ErrorResponse,
  type PaseoInfo,
  type ProviderInfo,
  type RunDetail,
  type RunSummary,
  type ServerInfo,
} from "./contracts.js";
import { isActiveRun, toRunDetail, toRunSummary, type GateDocumentView } from "./summary.js";

// `argos-core/rpc/server` re-exports the one storage owner so the CLI's `serve` command can open it
// without importing `argos-core/durable` anywhere in the CLI source (Phase 8 import-graph rule).
export { ArgosHost };
export type { ArgosHostOptions };

/** A 32-byte bearer token, hex encoded (FR27). */
const TOKEN_BYTES = 32;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const PROVIDER_PROBE_TIMEOUT_MS = 2_000;

// ------------------------------------------------------------------ token

/**
 * Read `$ARGOS_HOME/token`, creating it (`0600`, 32 random bytes) on first use. Only
 * `argos serve` calls this; clients read the file and never create it.
 */
export function ensureToken(home: string = argosHome()): string {
  ensureHome(home);
  const file = tokenPath(home);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= TOKEN_BYTES * 2) {
      chmodSync(file, ARGOS_TOKEN_MODE);
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: ARGOS_TOKEN_MODE });
  chmodSync(file, ARGOS_TOKEN_MODE);
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time token compare (both sides hashed, so length is not observable either). */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

// ------------------------------------------------------------------ options

/** Provider/Paseo probe for `GET /info`; wired by `argos serve`, stubbed in tests. */
export interface PaseoProbe {
  readonly url?: string;
  readonly mode?: "live" | "fake";
  snapshot(): Promise<ProviderCatalog>;
}

export interface CreateRpcServerOptions {
  readonly host: ArgosHost;
  /** Default `ARGOS_PORT` / 7676; `0` picks a free port (tests) and is reported back. */
  readonly port?: number;
  /** Bearer token; default {@link ensureToken}. */
  readonly token?: string;
  /** `$ARGOS_HOME`; default the host's home, then `argosHome()`. */
  readonly home?: string;
  /** Allowed browser origin(s); no CORS headers when omitted. */
  readonly cors?: string | readonly string[];
  /** Default `cwd` for `POST /runs` when the body omits one. */
  readonly cwd?: string;
  readonly paseo?: PaseoProbe;
  /** SSE `: ping` interval; default 15 s. */
  readonly heartbeatMs?: number;
  /** Request body cap; default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Diagnostic log sink (never receives the token); default silent. */
  readonly log?: (message: string) => void;
}

export interface RpcServer {
  readonly server: Server;
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly host: ArgosHost;
  /** Stop accepting, close every SSE stream, and release the listening socket. Idempotent. */
  close(): Promise<void>;
}

// ------------------------------------------------------------------ helpers

function defaultPort(): number {
  const raw = process.env["ARGOS_PORT"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_ARGOS_PORT;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} did not answer within ${ms} ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown, log: (message: string) => void): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map((part) => String(part)).join("."),
      message: issue.message,
    }));
    sendJson(res, 400, {
      error: {
        code: "invalid_request",
        message: `invalid request: ${issues.map((issue) => `${issue.path || "(body)"}: ${issue.message}`).join("; ")}`,
        details: { issues },
      },
    } satisfies ErrorResponse);
    return;
  }
  if (isArgosError(error)) {
    const details: Record<string, unknown> = {};
    if (error.file !== undefined) details["file"] = error.file;
    if (error.stepId !== undefined) details["stepId"] = error.stepId;
    sendJson(res, statusForCode(error.code), {
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(details).length === 0 ? {} : { details }),
      },
    } satisfies ErrorResponse);
    return;
  }
  log(`[argos] internal error: ${errorMessage(error)}`);
  sendJson(res, 500, {
    error: { code: "internal_error", message: errorMessage(error) },
  } satisfies ErrorResponse);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new ArgosError("invalid_request", `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArgosError("invalid_request", "request body is not valid JSON");
  }
}

/** Coerce one provided value to the playbook input's declared type. */
function coerceInput(ir: PlaybookIR, name: string, def: InputDefIR, value: Scalar): Scalar {
  switch (def.type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      throw new ArgosError(
        "invalid_request",
        `playbook ${ir.id}: input "${name}" must be a number`,
      );
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw new ArgosError(
        "invalid_request",
        `playbook ${ir.id}: input "${name}" must be true or false`,
      );
    }
    case "enum": {
      const text = String(value);
      if (def.values !== undefined && !def.values.includes(text)) {
        throw new ArgosError(
          "invalid_request",
          `playbook ${ir.id}: input "${name}" must be one of ${def.values.join(", ")}`,
        );
      }
      return text;
    }
    case "string": {
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;
    }
  }
}

/** Declared defaults, required-input checks, and CLI string coercion (FR7). */
function prepareInputs(
  ir: PlaybookIR,
  provided: Readonly<Record<string, Scalar>>,
): Record<string, Scalar> {
  const result: Record<string, Scalar> = {};
  for (const [name, def] of Object.entries(ir.inputs)) {
    const value = provided[name];
    if (value === undefined) {
      if (def.default !== undefined) result[name] = def.default;
      else if (def.required === true) {
        throw new ArgosError(
          "invalid_request",
          `playbook ${ir.id}: missing required input "${name}"`,
        );
      }
      continue;
    }
    result[name] = coerceInput(ir, name, def, value);
  }
  // Undeclared scalars stay available to templates, exactly like the engine's input map.
  for (const [name, value] of Object.entries(provided)) {
    if (!(name in result)) result[name] = value;
  }
  return result;
}

function sortSummaries(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort(
    (left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1),
  );
}

function providerInfos(catalog: ProviderCatalog): ProviderInfo[] {
  return ModelCatalog.fromSnapshot(catalog).snapshot().providers.map((provider) => ({
    provider: provider.provider,
    enabled: provider.enabled,
    models: [...provider.models],
    ...(provider.error === undefined ? {} : { error: provider.error }),
  }));
}

interface GateDocumentWire {
  readonly status: "pending" | "decided";
  readonly decision?: string | null | undefined;
  readonly comment?: string | null | undefined;
  readonly decidedBy?: string | null | undefined;
  readonly decidedVia?: string | null | undefined;
  readonly decidedAt?: number | null | undefined;
}

function gateDocumentWire(doc: GateDocumentView): GateDocumentWire {
  return {
    status: doc.status,
    decision: doc.decision,
    comment: doc.comment,
    decidedBy: doc.decidedBy,
    decidedVia: doc.decidedVia,
    decidedAt: doc.decidedAt,
  };
}

// ------------------------------------------------------------------ SSE connection

interface SseConnection {
  push(runId: string): void;
  close(): void;
}

// ------------------------------------------------------------------ server

/**
 * Open the loopback RPC server. Async only because `listen` is: the token is ensured (unless
 * injected), the observer is attached, and the actual port is reported back for `--port 0`.
 */
export async function createRpcServer(options: CreateRpcServerOptions): Promise<RpcServer> {
  const log = options.log ?? (() => undefined);
  const home = options.home ?? options.host.home ?? argosHome();
  const token = options.token ?? ensureToken(home);
  const cors = options.cors;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const startedAt = Date.now();
  const sseClients = new Set<SseConnection>();

  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    if (cors === undefined) return {};
    const allowed =
      typeof cors === "string"
        ? cors
        : cors.find((candidate) => candidate === origin) ?? cors[0] ?? "";
    if (allowed === "") return {};
    return {
      "access-control-allow-origin": allowed === "*" ? "*" : (origin ?? allowed),
      "access-control-allow-headers": "authorization, content-type, accept",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
    };
  };

  const serverInfo = async (port: number): Promise<ServerInfo> => {
    let paseo: PaseoInfo = {
      reachable: false,
      ...(options.paseo?.url === undefined ? {} : { url: options.paseo.url }),
      ...(options.paseo?.mode === undefined ? {} : { mode: options.paseo.mode }),
      ...(options.paseo === undefined ? { error: "no Paseo port configured" } : {}),
    };
    let providers: ProviderInfo[] = [];
    if (options.paseo !== undefined) {
      try {
        const catalog = await withTimeout(
          options.paseo.snapshot(),
          PROVIDER_PROBE_TIMEOUT_MS,
          "the Paseo daemon",
        );
        providers = providerInfos(catalog);
        paseo = { ...paseo, reachable: true };
      } catch (error) {
        paseo = { ...paseo, reachable: false, error: errorMessage(error) };
      }
    } else if (options.host.modelCatalog?.snapshot !== undefined) {
      providers = options.host.modelCatalog.snapshot().providers.map((provider) => ({
        provider: provider.provider,
        enabled: provider.enabled,
        models: [...provider.models],
        ...(provider.error === undefined ? {} : { error: provider.error }),
      }));
    }
    const docs = await options.host.listRuns();
    const summaries = docs.map((doc) => toRunSummary(doc));
    return {
      name: "argos",
      rpcVersion: ARGOS_RPC_VERSION,
      schemaVersion: ARGOS_SCHEMA_VERSION,
      pid: process.pid,
      port,
      home,
      node: process.versions.node,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      paseo,
      providers,
      pendingGates: summaries.flatMap((run) =>
        run.gates.filter((gate) => gate.status === "pending"),
      ),
      runs: {
        total: summaries.length,
        active: docs.filter((doc) => isActiveRun(doc.record)).length,
      },
    };
  };

  const currentPort = (): number => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : port;
  };

  const serveEvents = async (
    req: IncomingMessage,
    res: ServerResponse,
    extra: Record<string, string>,
  ): Promise<void> => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...extra,
    });
    let closed = false;
    let ready = false;
    let flushTimer: NodeJS.Timeout | undefined;
    const queued = new Set<string>();

    const write = (chunk: string): void => {
      if (closed || !ready) return;
      res.write(chunk);
    };

    const flush = async (): Promise<void> => {
      if (closed || !ready || queued.size === 0) return;
      const ids = [...queued];
      queued.clear();
      for (const runId of ids) {
        const doc = await options.host.getRun(runId);
        if (doc === undefined || closed) continue;
        write(`event: ${SSE_RUN_EVENT}\ndata: ${JSON.stringify(toRunSummary(doc))}\n\n`);
      }
    };

    const heartbeat = setInterval(() => {
      write(": ping\n\n");
    }, heartbeatMs);
    heartbeat.unref?.();

    const connection: SseConnection = {
      push(runId: string): void {
        if (closed) return;
        queued.add(runId);
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flush();
        }, 0);
        flushTimer.unref?.();
      },
      close(): void {
        if (closed) return;
        closed = true;
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        clearInterval(heartbeat);
        res.end();
      },
    };
    // Attach before the snapshot read: a commit landing while `listRuns` runs must not be lost.
    sseClients.add(connection);

    const cleanup = (): void => {
      connection.close();
      sseClients.delete(connection);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    const runs = await options.host.listRuns();
    if (closed) return;
    // The snapshot is the first frame; frames queued during the read flush right after it.
    res.write(
      `event: ${SSE_SNAPSHOT_EVENT}\ndata: ${JSON.stringify({
        runs: sortSummaries(runs.map((doc) => toRunSummary(doc))),
      })}\n\n`,
    );
    ready = true;
    void flush();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const extra = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204, extra);
      res.end();
      return;
    }

    const header = req.headers.authorization;
    const presented = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined;
    if (presented === undefined || !tokenMatches(presented, token)) {
      sendJson(
        res,
        401,
        { error: { code: "unauthorized", message: "a valid bearer token is required" } },
        extra,
      );
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${currentPort()}`);
    const segments = url.pathname.split("/").filter((segment) => segment !== "");

    try {
      // GET /health
      if (segments.length === 1 && segments[0] === "health") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "GET only" } }, extra);
          return;
        }
        sendJson(res, 200, { status: "ok" }, extra);
        return;
      }

      // GET /info (doctor)
      if (segments.length === 1 && segments[0] === "info") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "GET only" } }, extra);
          return;
        }
        sendJson(res, 200, await serverInfo(currentPort()), extra);
        return;
      }

      // GET /events (SSE)
      if (segments.length === 1 && segments[0] === "events") {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "GET only" } }, extra);
          return;
        }
        await serveEvents(req, res, extra);
        return;
      }

      if (segments[0] !== "runs") {
        sendJson(res, 404, { error: { code: "not_found", message: "unknown route" } }, extra);
        return;
      }

      // POST /runs
      if (segments.length === 1) {
        if (req.method === "GET") {
          const docs = await options.host.listRuns();
          sendJson(
            res,
            200,
            RunListResponseSchema.parse({
              runs: sortSummaries(docs.map((doc) => toRunSummary(doc))),
            }),
            extra,
          );
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "GET or POST" } }, extra);
          return;
        }
        const body = StartRunRequestSchema.parse(await readJson(req, maxBodyBytes));
        const cwd = body.cwd ?? options.cwd ?? process.cwd();
        // The loader is read-only and runs before `startRun`, so an invalid playbook never
        // creates a task (FR12). The host's home is where `argos serve` was opened, so global
        // playbooks under `<home>/playbooks` resolve even when `--home` differs from `ARGOS_HOME`.
        const ir = loadPlaybook(cwd, body.playbookId, { home });
        const inputs = prepareInputs(ir, body.inputs ?? {});
        const started = await options.host.startRun({
          ir,
          inputs,
          cwd,
          ...(body.isolation === undefined
            ? {}
            : { isolation: body.isolation as IsolationIR }),
          ...(body.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.clientRequestId }),
        });
        sendJson(res, 201, StartRunResponseSchema.parse(started), extra);
        return;
      }

      const runId = decodeURIComponent(segments[1] ?? "");
      if (runId === "") {
        sendJson(res, 404, { error: { code: "not_found", message: "missing run id" } }, extra);
        return;
      }

      // GET /runs/:id
      if (segments.length === 2 && req.method === "GET") {
        const doc = await options.host.getRun(runId);
        if (doc === undefined) {
          throw new ArgosError("run_unknown", `unknown run "${runId}"`);
        }
        const [history, gateDocuments] = await Promise.all([
          options.host.getHistory(runId),
          Promise.all(
            doc.record.gates.map(async (gate) => {
              const document = await options.host.getGate(runId, gate.id);
              return [gate.id, document] as const;
            }),
          ),
        ]);
        const documents = new Map<string, GateDocumentWire>();
        for (const [gateId, document] of gateDocuments) {
          if (document !== undefined) documents.set(gateId, gateDocumentWire(document));
        }
        const detail: RunDetail = toRunDetail(doc, history, documents);
        sendJson(res, 200, RunDetailSchema.parse(detail), extra);
        return;
      }

      // POST /runs/:id/cancel
      if (segments.length === 3 && segments[2] === "cancel") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "POST only" } }, extra);
          return;
        }
        const result = await options.host.cancelRun(runId);
        sendJson(res, 200, CancelRunResponseSchema.parse(result), extra);
        return;
      }

      // POST /runs/:id/retry
      if (segments.length === 3 && segments[2] === "retry") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "POST only" } }, extra);
          return;
        }
        const body = RetryRequestSchema.parse(await readJson(req, maxBodyBytes));
        const started = await options.host.retryStep(runId, body.stepId);
        sendJson(res, 201, StartRunResponseSchema.parse(started), extra);
        return;
      }

      // POST /runs/:id/gates/:gateId
      if (segments.length === 4 && segments[2] === "gates") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: { code: "method_not_allowed", message: "POST only" } }, extra);
          return;
        }
        const gateId = decodeURIComponent(segments[3] ?? "");
        const body = DecideGateRequestSchema.parse(await readJson(req, maxBodyBytes));
        const receipt = await options.host.decideGate(runId, gateId, body.decision, {
          ...(body.comment === undefined ? {} : { comment: body.comment }),
          ...(body.decidedBy === undefined ? {} : { decidedBy: body.decidedBy }),
          ...(body.decidedVia === undefined ? {} : { decidedVia: body.decidedVia }),
          ...(body.clientRequestId === undefined
            ? {}
            : { clientRequestId: body.clientRequestId }),
        });
        sendJson(res, 200, GateDecisionResponseSchema.parse(receipt), extra);
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: "unknown route" } }, extra);
    } catch (error) {
      sendError(res, error, log);
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      sendError(res, error, log);
    });
  });
  const detach = options.host.observeRuns((runId) => {
    for (const client of sseClients) client.push(runId);
  });

  const port = options.port ?? defaultPort();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  server.on("error", (error) => {
    log(`[argos] rpc server error: ${errorMessage(error)}`);
  });

  const actualPort = currentPort();
  const url = `http://127.0.0.1:${actualPort}`;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      detach();
      for (const client of [...sseClients]) client.close();
      sseClients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    })();
    return closing;
  };

  return { server, port: actualPort, token, url, host: options.host, close };
}
