/**
 * The production {@link HcPort} over the herdr-core Unix socket (FR27).
 *
 * **This is the only module in the repository allowed to import `node:net`.** The adapter, the
 * durable host, and every test speak the port interface instead, which keeps tests socket-free
 * and the rest of the codebase free of transport details. Nothing here starts a process either:
 * hc is a terminal host, and Argos never runs an `hc` CLI command.
 *
 * Wire contract (verified against `hc` 0.1.21, protocol generation 1):
 *
 * - JSON-RPC 2.0, **plain mode**: one JSON object per line in both directions, terminated by `\n`.
 *   Argos never sends `framed: true`, so the connection never leaves line mode.
 * - Params are **by name** (`paramStructure: "by-name"`); a method with no arguments omits
 *   `params` entirely.
 * - Responses correlate by `id`; a response for an unknown id (a call that timed out) is ignored,
 *   and an object without a numeric `id` (a notification) is never mistaken for a response.
 * - Errors carry `{code, message, data: {kind, hint}}`. Only `data.kind` crosses the port boundary
 *   (see `port.ts`): hc's `message` echoes parameters and the `hint` is prose, so neither reaches
 *   an Argos message, a log, or the database.
 *
 * Endpoint resolution follows hc's documented order (FR27):
 *
 * | # | Source               | Value                                                            |
 * |---|----------------------|------------------------------------------------------------------|
 * | 1 | `HC_SOCKET`          | the socket path, verbatim                                         |
 * | 2 | config `socket`      | `$XDG_CONFIG_HOME/herdr-core/config.toml`, else `~/.config/…`     |
 * | 3 | `$XDG_RUNTIME_DIR`   | `<dir>/herdr-core/<session>.sock`                                 |
 * | 4 | `/run/user/<uid>`    | `/run/user/<uid>/herdr-core/<session>.sock` (POSIX, and only when |
 * |   |                      | `<…>/herdr-core` exists — macOS never has it)                    |
 * | 5 | session state dir    | `$XDG_STATE_HOME/herdr-core/<session>/<session>.sock`, else       |
 * |   |                      | `~/.local/state/herdr-core/<session>/<session>.sock`              |
 *
 * `HC_SESSION` selects the session (default `default`). The state-dir form is the one that
 * exists on a stock macOS install: `~/.local/state/herdr-core/default/default.sock`.
 *
 * The client connects lazily on the first call and never retries or reconnects on its own: Argos
 * owns retry pacing (a step parks and retries, a launch fails the step), so an internal reconnect
 * loop would turn a hard failure into a silent hang.
 */

import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  HcKindError,
  HcTransportError,
  HC_PROTOCOL_GENERATION,
  normalizeHcKind,
  type HcHello,
  type HcFirstMessage,
  type HcListOptions,
  type HcPort,
  type HcReadOptions,
  type HcReadResult,
  type HcRemoveResult,
  type HcRunInput,
  type HcRunResult,
  type HcSendInput,
  type HcSendResult,
  type HcServerStatus,
  type HcTemplate,
  type HcTerminal,
  type HcTerminalStatus,
} from "./port.js";

/** Default per-call timeout; a step's own deadline still owns retries. */
export const DEFAULT_HC_TIMEOUT_MS = 5_000;

/** Default session name (`HC_SESSION` overrides it). */
export const DEFAULT_HC_SESSION = "default";

/**
 * A response line longer than this is refused instead of buffered forever: hc answers with one
 * JSON object per line, so an 8 MiB line means the peer is not speaking the protocol (or a
 * `terminal.read` of a huge screen). Read text is bounded by the caller's `lines` request.
 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Longest reason suffix taken from a socket error (`ECONNREFUSED`, `ENOENT`, …). */
const SOCKET_REASON_LIMIT = 120;

// ------------------------------------------------------------------ endpoint resolution

/** Which resolution step produced the path (FR27 order, `option` = programmatic override). */
export type HcEndpointSource = "option" | "env" | "config" | "runtime_dir" | "run_user" | "state_dir";

export interface HcEndpoint {
  readonly socket: string;
  readonly session: string;
  readonly source: HcEndpointSource;
}

export interface HcResolveOptions {
  /** Environment to read (`HC_SOCKET`, `HC_SESSION`, `XDG_*`); defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory used for `~/.config` and `~/.local/state`; defaults to `os.homedir()`. */
  readonly home?: string;
  /** Platform gate for `/run/user`; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Effective uid for `/run/user`; defaults to `process.getuid()`. */
  readonly uid?: number | undefined;
  /** Session name; defaults to `HC_SESSION`, else `default`. */
  readonly session?: string;
  /** Config file reader seam; defaults to `readFileSync` (a missing file is not an error). */
  readonly readConfig?: (path: string) => string | undefined;
  /** Directory probe for `/run/user/<uid>/herdr-core`; defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function defaultReadConfig(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A missing or unreadable config is expected: it only means "no `socket` configured".
    return undefined;
  }
}

/** Read one TOML string value: `"quoted"`, `'quoted'`, or a bare word with an inline comment. */
function readTomlString(raw: string): string | undefined {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end < 0) return undefined;
    const value = trimmed.slice(1, end).trim();
    return value.length === 0 ? undefined : value;
  }
  const comment = trimmed.indexOf("#");
  const bare = (comment < 0 ? trimmed : trimmed.slice(0, comment)).trim();
  return bare.length === 0 ? undefined : bare;
}

/**
 * The top-level `socket = "…"` of an hc config, or `undefined`. A deliberately minimal scan (no
 * TOML dependency): comments, CRLF, single or double quotes, and inline comments are tolerated,
 * a `[section]` header ends the top-level keys, and anything unparsable is ignored rather than
 * thrown — a bad config must never stop Argos from trying the next step of the chain.
 */
export function parseHcConfigSocket(text: string): string | undefined {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("[")) return undefined;
    const match = /^socket\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const value = readTomlString(match[1] ?? "");
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * FR27's endpoint chain. Every input (environment, home, platform, uid, config reader, directory
 * probe) is injectable, so the whole matrix is unit-testable without touching the real home.
 */
export function resolveHcSocket(options: HcResolveOptions = {}): HcEndpoint {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const session = clean(options.session) ?? clean(env["HC_SESSION"]) ?? DEFAULT_HC_SESSION;

  const explicit = clean(env["HC_SOCKET"]);
  if (explicit !== undefined) return { socket: explicit, session, source: "env" };

  const configHome = clean(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
  const readConfig = options.readConfig ?? defaultReadConfig;
  let configText: string | undefined;
  try {
    configText = readConfig(join(configHome, "herdr-core", "config.toml"));
  } catch {
    // An unreadable config (permissions, a broken mount) is "no socket configured": the chain
    // below still has to produce a usable path.
    configText = undefined;
  }
  const configured = parseHcConfigSocket(configText ?? "");
  if (configured !== undefined) return { socket: configured, session, source: "config" };

  const runtimeDir = clean(env["XDG_RUNTIME_DIR"]);
  if (runtimeDir !== undefined) {
    return { socket: join(runtimeDir, "herdr-core", `${session}.sock`), session, source: "runtime_dir" };
  }

  // `/run/user/<uid>` is inferred from the account rather than configured, and macOS/Windows
  // never have it. Probing the hc directory keeps a stock macOS install on the session state dir
  // below (where its core actually lives) instead of on a path that cannot exist.
  const uid = options.uid ?? (platform === "win32" ? undefined : process.getuid?.());
  if (platform !== "win32" && uid !== undefined) {
    const runUser = join("/run", "user", String(uid), "herdr-core");
    if ((options.exists ?? existsSync)(runUser)) {
      return { socket: join(runUser, `${session}.sock`), session, source: "run_user" };
    }
  }

  const stateHome = clean(env["XDG_STATE_HOME"]) ?? join(home, ".local", "state");
  return {
    socket: join(stateHome, "herdr-core", session, `${session}.sock`),
    session,
    source: "state_dir",
  };
}

/** The path only, for callers that do not care which step resolved it. */
export function resolveHcSocketPath(options: HcResolveOptions = {}): string {
  return resolveHcSocket(options).socket;
}

// ------------------------------------------------------------------ client

export interface HcClientOptions {
  /** Explicit socket path, above `HC_SOCKET` (tests and `argos serve` use it). */
  readonly socket?: string;
  /** Session name, above `HC_SESSION`. */
  readonly session?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number | undefined;
  readonly readConfig?: (path: string) => string | undefined;
  /** Per-call timeout; default {@link DEFAULT_HC_TIMEOUT_MS}. A timeout is not retried here. */
  readonly timeoutMs?: number;
  /** Longest accepted response line; default {@link DEFAULT_MAX_LINE_BYTES}. */
  readonly maxLineBytes?: number;
  /** Socket factory seam (tests inject one to avoid the real home). */
  readonly connect?: (socketPath: string) => Socket;
}

/** `HcPort` plus the lifecycle hooks `argos serve` uses. */
export interface HcClient extends HcPort {
  readonly socket: string;
  readonly session: string;
  readonly endpoint: HcEndpoint;
  /** End the socket and reject every pending call with `executor_unreachable`. Idempotent. */
  close(): Promise<void>;
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

/** A short reason for a socket failure: the errno code, never a payload. */
function socketReason(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (cause instanceof Error && cause.name.length > 0) return cause.name;
  return "unknown";
}

function asRecord(value: unknown, method: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HcTransportError(`hc ${method} returned a result that is not a JSON object`);
  }
  return value;
}

function toStatus(value: unknown): HcTerminalStatus | null {
  if (!isRecord(value) || typeof value["state"] !== "string") return null;
  return {
    state: value["state"],
    msg: nullableString(value["msg"]),
    title: nullableString(value["title"]),
    kind: nullableString(value["kind"]),
    progress: nullableNumber(value["progress"]),
  };
}

function toFirstMessage(value: unknown): HcFirstMessage | null {
  if (!isRecord(value) || typeof value["sent"] !== "boolean") return null;
  return {
    sent: value["sent"],
    started: typeof value["started"] === "boolean" ? value["started"] : null,
    turn: nullableNumber(value["turn"]),
    reason: nullableString(value["reason"]),
  };
}

/** Normalize one `Terminal` (from `run`, `get`, or `list`) into the port's stable shape. */
function toTerminal(value: unknown, method: string): HcTerminal {
  const raw = asRecord(value, method);
  const address = raw["address"];
  if (typeof address !== "string" || address.length === 0) {
    throw new HcTransportError(`hc ${method} returned a terminal without an address`);
  }
  return {
    address,
    name: nullableString(raw["name"]),
    state: raw["state"] === "finished" ? "finished" : "live",
    status: toStatus(raw["status"]),
    turn: numberOr(raw["turn"], 0),
    exit_code: nullableNumber(raw["exit_code"]),
    signal: nullableNumber(raw["signal"]),
    reason: nullableString(raw["reason"]),
    labels: stringRecord(raw["labels"]),
    argv: stringList(raw["argv"]),
    cwd: stringOr(raw["cwd"], ""),
    pid: nullableNumber(raw["pid"]),
    created_ms: numberOr(raw["created_ms"], 0),
    finished_ms: nullableNumber(raw["finished_ms"]),
    screen: stringOr(raw["screen"], ""),
    title: stringOr(raw["title"], ""),
    reported: booleanOr(raw["reported"], false),
    template: nullableString(raw["template"]),
    first_message: toFirstMessage(raw["first_message"]),
  };
}

/**
 * Build the production port. Nothing connects at construction time, so `argos serve` never
 * depends on a live core; the first call opens the socket, and a lost socket is dropped so the
 * next call reconnects (a step's poll or the next run, never a background loop).
 */
export function createHcClient(options: HcClientOptions = {}): HcClient {
  const resolved = resolveHcSocket({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.readConfig === undefined ? {} : { readConfig: options.readConfig }),
  });
  const endpoint: HcEndpoint =
    options.socket === undefined ? resolved : { ...resolved, socket: options.socket, source: "option" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_HC_TIMEOUT_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const connect = options.connect ?? ((socketPath: string) => createConnection(socketPath));

  const pending = new Map<number, PendingCall>();
  let socket: Socket | undefined;
  let connecting: Promise<Socket> | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let nextId = 1;
  let closed = false;

  function transportError(message: string, cause?: unknown): HcTransportError {
    return new HcTransportError(message, {
      ...(cause === undefined ? {} : { cause }),
      socket: endpoint.socket,
    });
  }

  function failAll(error: Error): void {
    const calls = [...pending.values()];
    pending.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.reject(error);
    }
  }

  function dropSocket(target?: Socket): void {
    const current = target ?? socket;
    if (current === undefined) return;
    if (socket === current) socket = undefined;
    current.destroy();
  }

  function handleLine(line: Buffer): void {
    const text = line.toString("utf8").trim();
    if (text.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (cause) {
      // The stream is no longer line-delimited JSON-RPC (a framed or binary reply): every call
      // in flight is unresolvable, so fail them all instead of waiting for each timeout.
      failAll(transportError("hc sent a response that is not JSON", cause));
      dropSocket();
      return;
    }
    if (!isRecord(message)) {
      failAll(transportError("hc sent a response that is not a JSON-RPC object"));
      dropSocket();
      return;
    }
    const id = message["id"];
    // Notifications (no `id`) and ids this client never issued are not ours to answer.
    if (typeof id !== "number") return;
    const call = pending.get(id);
    if (call === undefined) return;
    pending.delete(id);
    clearTimeout(call.timer);
    const error = message["error"];
    if (error !== undefined && error !== null) {
      call.reject(toKindError(error, call.method));
      return;
    }
    call.resolve(message["result"]);
  }

  function onData(target: Socket, chunk: Buffer): void {
    if (target !== socket) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index < 0) break;
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      handleLine(line);
    }
    if (buffer.length > maxLineBytes) {
      failAll(transportError(`hc sent a response line longer than ${maxLineBytes} bytes`));
      buffer = Buffer.alloc(0);
      dropSocket(target);
    }
  }

  function onClose(target: Socket): void {
    // A socket that was already dropped or replaced must not fail the calls of its successor.
    if (socket !== target) return;
    socket = undefined;
    buffer = Buffer.alloc(0);
    failAll(transportError("the herdr-core connection closed"));
  }

  function attach(target: Socket): void {
    target.on("data", (chunk: Buffer) => onData(target, chunk));
    target.on("error", (cause: Error) => {
      if (socket !== target) return;
      buffer = Buffer.alloc(0);
      dropSocket(target);
      failAll(
        transportError(
          `the herdr-core connection failed: ${socketReason(cause).slice(0, SOCKET_REASON_LIMIT)}`,
          cause,
        ),
      );
    });
    target.on("close", () => onClose(target));
  }

  function open(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      let created: Socket;
      try {
        created = connect(endpoint.socket);
      } catch (cause) {
        reject(transportError(`cannot open the hc socket at ${endpoint.socket}`, cause));
        return;
      }
      const onConnectError = (cause: Error): void => {
        created.off("connect", onConnect);
        created.destroy();
        reject(
          transportError(
            `cannot reach the herdr-core core at ${endpoint.socket}: ` +
              socketReason(cause).slice(0, SOCKET_REASON_LIMIT),
            cause,
          ),
        );
      };
      const onConnect = (): void => {
        created.off("error", onConnectError);
        if (closed) {
          created.destroy();
          reject(transportError("the hc client was closed"));
          return;
        }
        attach(created);
        socket = created;
        resolve(created);
      };
      created.once("error", onConnectError);
      created.once("connect", onConnect);
    });
  }

  async function ensureSocket(): Promise<Socket> {
    if (closed) throw transportError("the hc client was closed");
    if (socket !== undefined && !socket.destroyed) return socket;
    if (connecting === undefined) {
      connecting = open().finally(() => {
        connecting = undefined;
      });
    }
    const target = await connecting;
    if (closed) throw transportError("the hc client was closed");
    return target;
  }

  /** Send one request line and await its correlated response. */
  async function call(
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const target = await ensureSocket();
    const id = nextId;
    nextId += 1;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Leave the socket alone: a slow core is not a broken one, and a late answer for this id
        // is ignored. The caller (a step poll, a doctor probe) owns the retry.
        reject(transportError(`hc ${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { method, resolve, reject, timer });
      target.write(`${JSON.stringify(request)}\n`, (cause) => {
        if (cause === undefined || cause === null) return;
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(transportError(`cannot write to the hc socket: ${socketReason(cause)}`, cause));
      });
    });
  }

  return {
    socket: endpoint.socket,
    session: endpoint.session,
    endpoint,

    async hello(): Promise<HcHello> {
      // `generation` tells the core which protocol we speak; a mismatch is `unsupported_generation`
      // (→ `executor_unavailable`) instead of a step failing on a shape it cannot read. `framed`
      // is never sent: Argos stays in plain mode.
      const raw = asRecord(
        await call("hello", { generation: HC_PROTOCOL_GENERATION }),
        "hello",
      );
      const core = raw["core"];
      return {
        generation: numberOr(raw["generation"], HC_PROTOCOL_GENERATION),
        version: stringOr(raw["version"], ""),
        core: {
          id: isRecord(core) ? stringOr(core["id"], "") : "",
          name: isRecord(core) ? stringOr(core["name"], "") : "",
        },
        framed: raw["framed"] === true,
        methods: stringList(raw["methods"]),
        features: stringList(raw["features"]),
      };
    },

    async serverStatus(): Promise<HcServerStatus> {
      const raw = asRecord(await call("server.status"), "server.status");
      const core = raw["core"];
      return {
        core: {
          id: isRecord(core) ? stringOr(core["id"], "") : "",
          name: isRecord(core) ? stringOr(core["name"], "") : "",
        },
        pid: numberOr(raw["pid"], 0),
        version: stringOr(raw["version"], ""),
        uptimeMs: numberOr(raw["uptime_ms"], 0),
        live: numberOr(raw["live"], 0),
        finished: numberOr(raw["finished"], 0),
      };
    },

    async templatesList(): Promise<HcTemplate[]> {
      const raw = asRecord(await call("templates.list"), "templates.list");
      const entries = Array.isArray(raw["templates"]) ? raw["templates"] : [];
      const templates: HcTemplate[] = [];
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const name = stringOr(entry["name"], "");
        if (name.length === 0) continue;
        templates.push({
          name,
          description: stringOr(entry["description"], ""),
          command: stringOr(entry["command"], ""),
          error: nullableString(entry["error"]),
        });
      }
      return templates;
    },

    async runTerminal(input: HcRunInput): Promise<HcRunResult> {
      const params: Record<string, unknown> = { argv: [...input.argv] };
      if (input.cwd !== undefined) params["cwd"] = input.cwd;
      if (input.name !== undefined) params["name"] = input.name;
      if (input.labels !== undefined) params["labels"] = { ...input.labels };
      if (input.env !== undefined) params["env"] = { ...input.env };
      if (input.line !== undefined) params["line"] = input.line;
      if (input.size !== undefined) params["size"] = { ...input.size };
      if (input.keep !== undefined) params["keep"] = input.keep;
      if (input.rm !== undefined) params["rm"] = input.rm;
      if (input.wait !== undefined) params["wait"] = input.wait;
      if (input.timeout !== undefined) params["timeout"] = input.timeout;
      const raw = asRecord(await call("terminal.run", params), "terminal.run");
      return {
        ...toTerminal(raw, "terminal.run"),
        output: nullableString(raw["output"]),
      };
    },

    async getTerminal(terminal: string): Promise<HcTerminal> {
      return toTerminal(await call("terminal.get", { terminal }), "terminal.get");
    },

    async listTerminals(options: HcListOptions = {}): Promise<HcTerminal[]> {
      const params: Record<string, unknown> = {};
      if (options.all !== undefined) params["all"] = options.all;
      if (options.labels !== undefined) params["labels"] = { ...options.labels };
      const raw = asRecord(
        await call("terminal.list", Object.keys(params).length === 0 ? undefined : params),
        "terminal.list",
      );
      const entries = Array.isArray(raw["terminals"]) ? raw["terminals"] : [];
      return entries.map((entry) => toTerminal(entry, "terminal.list"));
    },

    async sendText(input: HcSendInput): Promise<HcSendResult> {
      const params: Record<string, unknown> = { terminal: input.terminal, text: input.text };
      if (input.if !== undefined) params["if"] = input.if;
      if (input.force !== undefined) params["force"] = input.force;
      if (input.wait !== undefined) params["wait"] = input.wait;
      if (input.timeout !== undefined) params["timeout"] = input.timeout;
      const raw = asRecord(await call("terminal.send", params), "terminal.send");
      return {
        turn: numberOr(raw["turn"], 0),
        status: nullableString(raw["status"]),
        started: typeof raw["started"] === "boolean" ? raw["started"] : null,
      };
    },

    async readTerminal(terminal: string, options: HcReadOptions = {}): Promise<HcReadResult> {
      const params: Record<string, unknown> = { terminal };
      if (options.lines !== undefined) params["lines"] = options.lines;
      const raw = asRecord(await call("terminal.read", params), "terminal.read");
      return {
        text: stringOr(raw["text"], ""),
        complete: booleanOr(raw["complete"], false),
        how: stringOr(raw["how"], ""),
        why: nullableString(raw["why"]),
      };
    },

    async removeTerminal(terminal: string): Promise<HcRemoveResult> {
      const raw = asRecord(await call("terminal.rm", { terminal }), "terminal.rm");
      return { removed: stringOr(raw["removed"], "") };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Reject before destroying so a pending call always sees the "closed" text, then let the
      // `close` handler run over an empty map (it is a no-op).
      failAll(transportError("the hc client was closed"));
      const current = socket;
      socket = undefined;
      connecting = undefined;
      buffer = Buffer.alloc(0);
      if (current === undefined) return;
      current.end();
      current.destroy();
    },
  };
}

/**
 * Build the JSON-RPC error for one response. Only `data.kind` is read: hc's `message` echoes the
 * parameters (terminal names, prompt text) and `hint` is CLI prose, so neither is kept.
 */
function toKindError(error: unknown, method: string): HcKindError {
  const data = isRecord(error) && isRecord(error["data"]) ? error["data"] : {};
  return new HcKindError(normalizeHcKind(data["kind"]), method);
}
