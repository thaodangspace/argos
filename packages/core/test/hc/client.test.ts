/**
 * The `hc` transport (FR25/FR27, plan Phase 5).
 *
 * Only this suite opens a socket, and it is always a real **Unix socket server in a temp
 * directory**, created per test and closed (with its clients) in `afterEach` — loopback,
 * deterministic, no agent, no CLI process. Everything else about the port is unit-tested.
 *
 * What is proven here:
 *
 * 1. FR27's endpoint chain: `HC_SOCKET` → config → `$XDG_RUNTIME_DIR` → `/run/user/<uid>` →
 *    state dir, with `HC_SESSION` selecting the session.
 * 2. Plain-mode framing: one JSON object per line, in both directions, correlated by `id`
 *    (two messages in one chunk, one message split across chunks, an unknown id ignored).
 * 3. FR25's error mapping: a JSON-RPC `data.kind` becomes `HcKindError`, and neither the kind nor
 *    hc's `message`/`hint` (which echo parameters) reaches the Argos message.
 * 4. Lifecycle: per-call timeout, a refused connection, a broken/oversized line, and `close()`
 *    rejecting every pending call with `executor_unreachable`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HC_SESSION,
  DEFAULT_HC_TIMEOUT_MS,
  DEFAULT_MAX_LINE_BYTES,
  createHcClient,
  parseHcConfigSocket,
  resolveHcSocket,
  resolveHcSocketPath,
  type HcClient,
} from "../../src/hc/client.js";
import {
  HC_ERROR_KINDS,
  HcKindError,
  HcTransportError,
  classifyHcKind,
  hcFailureCode,
  isHcKindError,
  isHcTransportError,
  normalizeHcKind,
  type HcErrorKind,
} from "../../src/hc/port.js";

// ------------------------------------------------------------------ a real local core

interface TestRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly raw: string;
}

type RequestHandler = (request: TestRequest, socket: Socket) => void;

/** Minimal hc stand-in: one JSON object per line in, whatever the handler writes out. */
class TestCore {
  readonly path: string;
  readonly requests: TestRequest[] = [];
  handler: RequestHandler = () => undefined;
  #server: Server | undefined;
  #stopped = false;
  readonly #sockets = new Set<Socket>();

  constructor(directory: string) {
    this.path = join(directory, "hc.sock");
  }

  async start(): Promise<void> {
    const server = createServer((socket) => {
      this.#sockets.add(socket);
      let buffer = "";
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          const message = JSON.parse(line) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const request: TestRequest = {
            id: message.id,
            method: message.method,
            params: message.params,
            raw: line,
          };
          this.requests.push(request);
          this.handler(request, socket);
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => resolve());
    });
  }

  respond(socket: Socket, id: number, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  fail(socket: Socket, id: number, error: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
  }

  /** Write raw bytes (framing, broken lines, oversized lines). */
  write(socket: Socket, raw: string): void {
    socket.write(raw);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const tempDirs: string[] = [];
const cores: TestCore[] = [];
const clients: HcClient[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "argos-hc-"));
  tempDirs.push(directory);
  return directory;
}

async function startCore(): Promise<TestCore> {
  const core = new TestCore(tempDir());
  await core.start();
  cores.push(core);
  return core;
}

function client(core: TestCore, options: { timeoutMs?: number; maxLineBytes?: number } = {}): HcClient {
  const created = createHcClient({
    socket: core.path,
    timeoutMs: options.timeoutMs ?? 1_000,
    ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
  });
  clients.push(created);
  return created;
}

afterEach(async () => {
  for (const created of clients.splice(0)) await created.close().catch(() => undefined);
  for (const core of cores.splice(0)) await core.stop();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Await a rejection and return it (assertions read better than try/catch here). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

/** Poll until `check` is true; the socket handshake is asynchronous, so this beats fixed sleeps. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A `server.status` payload with a distinctive `live` count. */
function statusResult(live: number): Record<string, unknown> {
  return {
    core: { id: "core-1", name: "host" },
    pid: 42,
    version: "0.1.21",
    uptime_ms: 1_000,
    live,
    finished: 3,
  };
}

function helloResult(version: string): Record<string, unknown> {
  return {
    generation: 1,
    version,
    core: { id: "core-1", name: "host" },
    framed: false,
    methods: ["hello", "server.status"],
    features: ["status"],
  };
}

// ------------------------------------------------------------------ FR27: endpoint chain

describe("hc endpoint resolution (FR27)", () => {
  it("prefers HC_SOCKET above everything else", () => {
    const endpoint = resolveHcSocket({
      env: { HC_SOCKET: "/tmp/explicit.sock", XDG_RUNTIME_DIR: "/run/x" },
      home: "/home/argos",
      platform: "linux",
      uid: 1000,
      readConfig: () => 'socket = "/tmp/config.sock"\n',
    });
    expect(endpoint).toEqual({
      socket: "/tmp/explicit.sock",
      session: DEFAULT_HC_SESSION,
      source: "env",
    });
  });

  it("reads the top-level config `socket` through the injected reader", () => {
    const paths: string[] = [];
    const endpoint = resolveHcSocket({
      env: { XDG_CONFIG_HOME: "/custom/config", XDG_RUNTIME_DIR: "/run/x" },
      home: "/home/argos",
      platform: "linux",
      uid: 1000,
      readConfig: (path) => {
        paths.push(path);
        // CRLF, a comment, a top-level value, then a table with the same key (which must lose).
        return [
          "# herdr-core config",
          "",
          'socket = "/tmp/from-config.sock"',
          "",
          "[ui]",
          'socket = "/tmp/in-a-table.sock"',
          "",
        ].join("\r\n");
      },
    });
    expect(paths).toEqual([join("/custom/config", "herdr-core", "config.toml")]);
    expect(endpoint).toEqual({
      socket: "/tmp/from-config.sock",
      session: DEFAULT_HC_SESSION,
      source: "config",
    });
  });

  it("falls back to ~/.config/herdr-core/config.toml and tolerates quotes and comments", () => {
    const paths: string[] = [];
    const endpoint = resolveHcSocket({
      env: {},
      home: "/home/argos",
      platform: "linux",
      uid: 1000,
      readConfig: (path) => {
        paths.push(path);
        return "socket = '/tmp/single.sock' # the socket\n";
      },
    });
    expect(paths).toEqual([join("/home/argos", ".config", "herdr-core", "config.toml")]);
    expect(endpoint.source).toBe("config");
    expect(endpoint.socket).toBe("/tmp/single.sock");
  });

  it("ignores a section-scoped socket and an unreadable config instead of throwing", () => {
    expect(parseHcConfigSocket('[ui]\nsocket = "/tmp/nope.sock"\n')).toBeUndefined();
    expect(parseHcConfigSocket('name = "x"\nsocket = \n')).toBeUndefined();
    expect(parseHcConfigSocket('socket = "/tmp/unterminated\n')).toBeUndefined();
    const endpoint = resolveHcSocket({
      env: { XDG_STATE_HOME: "/state" },
      home: "/home/argos",
      platform: "linux",
      uid: 1000,
      exists: () => false,
      readConfig: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(endpoint).toEqual({
      socket: join("/state", "herdr-core", "default", "default.sock"),
      session: "default",
      source: "state_dir",
    });
  });

  it("uses $XDG_RUNTIME_DIR/herdr-core/<session>.sock next", () => {
    expect(
      resolveHcSocket({ env: { XDG_RUNTIME_DIR: "/run/user/501" }, platform: "linux", uid: 501 }),
    ).toEqual({
      socket: join("/run/user/501", "herdr-core", "default.sock"),
      session: "default",
      source: "runtime_dir",
    });
  });

  it("uses /run/user/<uid>/herdr-core/<session>.sock when no runtime dir is set", () => {
    expect(
      resolveHcSocket({
        env: {},
        home: "/home/argos",
        platform: "linux",
        uid: 1000,
        exists: () => true,
      }),
    ).toEqual({
      socket: join("/run", "user", "1000", "herdr-core", "default.sock"),
      session: "default",
      source: "run_user",
    });
  });

  it("skips /run/user when that hc directory does not exist", () => {
    expect(
      resolveHcSocket({
        env: {},
        home: "/home/argos",
        platform: "linux",
        uid: 1000,
        exists: () => false,
      }),
    ).toEqual({
      socket: join("/home/argos", ".local", "state", "herdr-core", "default", "default.sock"),
      session: "default",
      source: "state_dir",
    });
  });

  it("uses the session state dir last, and HC_SESSION selects the session", () => {
    expect(
      resolveHcSocket({
        env: { HC_SESSION: "ops" },
        home: "/home/argos",
        platform: "linux",
        uid: 1000,
        exists: () => false,
      }),
    ).toEqual({
      socket: join("/home/argos", ".local", "state", "herdr-core", "ops", "ops.sock"),
      session: "ops",
      source: "state_dir",
    });
    expect(
      resolveHcSocket({
        env: { HC_SESSION: "ops", XDG_STATE_HOME: "/state" },
        home: "/home/argos",
        platform: "linux",
        uid: 1000,
        exists: () => false,
      }).socket,
    ).toBe(join("/state", "herdr-core", "ops", "ops.sock"));
  });

  it("skips /run/user on Windows and keeps the state dir", () => {
    const endpoint = resolveHcSocket({
      env: {},
      home: "C:\\Users\\argos",
      platform: "win32",
      uid: 1000,
      exists: () => true,
    });
    expect(endpoint.source).toBe("state_dir");
    expect(endpoint.socket).toContain("herdr-core");
    expect(endpoint.socket).not.toContain("/run/user");
  });

  it("resolves the stock macOS core from the session state dir", () => {
    // The live core on a stock install lives exactly here (no env, no config entry, no
    // /run/user/herdr-core directory).
    expect(
      resolveHcSocketPath({
        env: {},
        home: homedir(),
        platform: "darwin",
        uid: 501,
        exists: () => false,
      }),
    ).toBe(join(homedir(), ".local", "state", "herdr-core", "default", "default.sock"));
  });
});

// ------------------------------------------------------------------ FR25: kind mapping

describe("hc error kinds (FR25)", () => {
  const expected: Readonly<Record<Exclude<HcErrorKind, "unknown">, string>> = {
    not_found: "agent_missing",
    machine_unknown: "agent_missing",
    name_taken: "launch_uncertain",
    blocked: "step_failed",
    status_mismatch: "step_failed",
    finished: "step_failed",
    live: "step_failed",
    invalid_params: "step_failed",
    unavailable: "executor_unavailable",
    unreachable: "executor_unreachable",
    spawn_failed: "step_failed",
    conflict: "step_failed",
    hc_missing: "executor_unavailable",
    incompatible: "executor_unavailable",
    unsupported_generation: "executor_unavailable",
    needs_update: "executor_unavailable",
  };

  it("maps every enumerated kind to its stable Argos code", () => {
    for (const kind of HC_ERROR_KINDS) {
      expect(classifyHcKind(kind), kind).toBe(expected[kind]);
    }
    expect(HC_ERROR_KINDS).toHaveLength(Object.keys(expected).length);
    expect(classifyHcKind("unknown")).toBe("executor_unavailable");
  });

  it("normalizes an unknown or malformed kind to `unknown`", () => {
    expect(normalizeHcKind("not_found")).toBe("not_found");
    expect(normalizeHcKind(" not_found ")).toBe("not_found");
    expect(normalizeHcKind("brand_new_kind")).toBe("unknown");
    expect(normalizeHcKind(undefined)).toBe("unknown");
    expect(normalizeHcKind(7)).toBe("unknown");
  });

  it("never puts the kind in the message and bounds every message", () => {
    for (const kind of [...HC_ERROR_KINDS, "unknown" as const]) {
      const error = new HcKindError(kind, "terminal.get");
      expect(error.message, kind).not.toContain(kind);
      expect(error.message.length).toBeLessThanOrEqual(200);
      expect(error.argosCode).toBe(classifyHcKind(kind));
      expect(isHcKindError(error)).toBe(true);
    }
    const transport = new HcTransportError("x".repeat(5_000), { socket: "/tmp/x.sock" });
    expect(transport.message.length).toBeLessThanOrEqual(200);
    expect(transport.argosCode).toBe("executor_unreachable");
    expect(isHcTransportError(transport)).toBe(true);
    expect(isHcTransportError(new HcKindError("not_found", "terminal.get"))).toBe(false);
  });

  it("routes every failure shape through hcFailureCode", () => {
    expect(hcFailureCode(new HcTransportError("down"))).toBe("executor_unreachable");
    expect(hcFailureCode(new HcKindError("not_found", "terminal.read"))).toBe("agent_missing");
    expect(hcFailureCode(new HcKindError("hc_missing", "hello"))).toBe("executor_unavailable");
    expect(hcFailureCode(new Error("boom"))).toBe("step_failed");
    expect(hcFailureCode(new Error("boom"), "invalid_output")).toBe("invalid_output");
  });
});

// ------------------------------------------------------------------ JSON-RPC over a socket

describe("hc client over a real Unix socket", () => {
  it("lazily connects and sends one JSON-RPC object per line with by-name params", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      if (request.method === "server.status") core.respond(socket, request.id, statusResult(2));
    };
    const hc = client(core);
    // Nothing is opened at construction time: no request exists before the first call.
    expect(core.requests).toHaveLength(0);

    await expect(hc.serverStatus()).resolves.toEqual({
      core: { id: "core-1", name: "host" },
      pid: 42,
      version: "0.1.21",
      uptimeMs: 1_000,
      live: 2,
      finished: 3,
    });
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0]?.method).toBe("server.status");
    // A method with no arguments omits `params` entirely.
    expect(core.requests[0]?.params).toBeUndefined();
    expect(JSON.parse(core.requests[0]?.raw ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "server.status",
    });
  });

  it("parses two responses in one chunk and one response split across chunks", async () => {
    const core = await startCore();
    const held: TestRequest[] = [];
    core.handler = (request, socket) => {
      if (request.method === "server.status") {
        held.push(request);
        if (held.length < 2) return;
        const first = held[0];
        const second = held[1];
        if (first === undefined || second === undefined) return;
        // Both responses in a single write: two JSON objects, one chunk.
        core.write(
          socket,
          `${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: statusResult(1) })}\n` +
            `${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: statusResult(2) })}\n`,
        );
        return;
      }
      if (request.method === "templates.list") {
        const line = `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { templates: [{ name: "claude", description: "d", command: "c", error: null }] },
        })}\n`;
        // Two writes with a macrotask between them: the client must stitch the line back together.
        core.write(socket, line.slice(0, 12));
        setImmediate(() => core.write(socket, line.slice(12)));
      }
    };
    const hc = client(core);

    const [first, second] = await Promise.all([hc.serverStatus(), hc.serverStatus()]);
    expect(first.live).toBe(1);
    expect(second.live).toBe(2);

    await expect(hc.templatesList()).resolves.toEqual([
      { name: "claude", description: "d", command: "c", error: null },
    ]);
  });

  it("correlates out-of-order concurrent responses to their own calls", async () => {
    const core = await startCore();
    const held: TestRequest[] = [];
    core.handler = (request, socket) => {
      held.push(request);
      if (held.length < 3) return;
      // Answer in reverse order; each payload is unique to its method.
      for (const entry of [...held].reverse()) {
        if (entry.method === "server.status") core.respond(socket, entry.id, statusResult(11));
        if (entry.method === "hello") core.respond(socket, entry.id, helloResult("9.9.9"));
        if (entry.method === "templates.list") {
          core.respond(socket, entry.id, {
            templates: [{ name: "codex", description: "x", command: "codex", error: null }],
          });
        }
      }
    };
    const hc = client(core);

    const [status, hello, templates] = await Promise.all([
      hc.serverStatus(),
      hc.hello(),
      hc.templatesList(),
    ]);
    expect(status.live).toBe(11);
    expect(hello.version).toBe("9.9.9");
    expect(templates.map((template) => template.name)).toEqual(["codex"]);
    // Three calls, three distinct ids, one line each.
    expect(new Set(core.requests.map((request) => request.id)).size).toBe(3);
    for (const request of core.requests) expect(request.raw).not.toContain("\n");
  });

  it("ignores a response for an id it never issued, and notifications", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.write(socket, `${JSON.stringify({ jsonrpc: "2.0", id: 9_999, result: { bogus: true } })}\n`);
      core.write(socket, `${JSON.stringify({ jsonrpc: "2.0", method: "terminal.status" })}\n`);
      core.respond(socket, request.id, statusResult(7));
    };
    const hc = client(core);
    await expect(hc.serverStatus()).resolves.toMatchObject({ live: 7 });
  });

  it("maps `data.kind` to a typed error without leaking kind, hint, or parameters", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.fail(socket, request.id, {
        code: -32000,
        // hc echoes the parameter in its message; that text must not survive.
        message: 'no terminal "s3cr3t-prompt-text"',
        data: { kind: "not_found", hint: "see `hc ls --all`" },
      });
    };
    const hc = client(core);

    const error = await rejection(hc.getTerminal("s3cr3t-prompt-text"));
    expect(error).toBeInstanceOf(HcKindError);
    const kindError = error as HcKindError;
    expect(kindError.kind).toBe("not_found");
    expect(kindError.method).toBe("terminal.get");
    expect(kindError.argosCode).toBe("agent_missing");
    expect(kindError.message).not.toContain("not_found");
    expect(kindError.message).not.toContain("s3cr3t-prompt-text");
    expect(kindError.message).not.toContain("hc ls --all");
    expect(kindError.message.length).toBeLessThanOrEqual(200);
  });

  it("keeps an unrecognized kind on the typed error", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.fail(socket, request.id, {
        code: -32000,
        message: "future",
        data: { kind: "brand_new_kind" },
      });
    };
    const hc = client(core);
    const error = (await rejection(hc.hello())) as HcKindError;
    expect(error.kind).toBe("unknown");
    expect(error.argosCode).toBe("executor_unavailable");
  });

  it("never asks for framed mode and announces the protocol generation", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.respond(socket, request.id, helloResult("0.1.21"));
    };
    const hc = client(core);
    await expect(hc.hello()).resolves.toMatchObject({ generation: 1, framed: false });
    expect(core.requests[0]?.params).toStrictEqual({ generation: 1 });
    expect(core.requests[0]?.raw).not.toContain("framed");
  });

  it("times out one call without disturbing the connection", async () => {
    const core = await startCore();
    expect(DEFAULT_HC_TIMEOUT_MS).toBe(5_000);
    core.handler = (request, socket) => {
      // Never answer the first call; answer the second one normally.
      if (request.method !== "templates.list") return;
      if (core.requests.filter((entry) => entry.method === "templates.list").length === 1) return;
      core.respond(socket, request.id, { templates: [] });
    };
    const hc = client(core, { timeoutMs: 30 });

    const error = await rejection(hc.templatesList());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).argosCode).toBe("executor_unreachable");
    expect((error as HcTransportError).message).toContain("did not answer");
    await expect(hc.templatesList()).resolves.toEqual([]);
  });

  it("rejects pending calls on close with executor_unreachable, and a second close is a no-op", async () => {
    const core = await startCore();
    core.handler = () => undefined; // never answer
    const hc = client(core);

    const pending = rejection(hc.serverStatus());
    // Wait until the request reached the server, so the call is genuinely in flight.
    await waitFor(() => core.requests.length === 1, "the request to arrive");

    await hc.close();
    const error = await pending;
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).argosCode).toBe("executor_unreachable");

    await expect(hc.close()).resolves.toBeUndefined();
    // A call after close fails immediately instead of hanging or rebuilding the socket.
    await expect(hc.serverStatus()).rejects.toBeInstanceOf(HcTransportError);
  });

  it("fails with a transport error when nothing is listening", async () => {
    const core = await startCore();
    await core.stop();
    const hc = client(core);
    const error = await rejection(hc.serverStatus());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).argosCode).toBe("executor_unreachable");
    expect((error as HcTransportError).message).toContain(core.path);
  });

  it("fails a pending call when the core drops the connection, then reconnects on the next call", async () => {
    const core = await startCore();
    let connections = 0;
    core.handler = (request, socket) => {
      connections += 1;
      if (connections === 1) {
        socket.destroy();
        return;
      }
      core.respond(socket, request.id, statusResult(5));
    };
    const hc = client(core);

    const error = await rejection(hc.serverStatus());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).message).toContain("closed");

    // The dead socket was dropped, so the next call opens a fresh connection.
    await expect(hc.serverStatus()).resolves.toMatchObject({ live: 5 });
    expect(connections).toBe(2);
  });

  it("refuses an oversized response line instead of buffering forever", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.write(socket, "x".repeat(4_096));
    };
    const hc = client(core, { maxLineBytes: 512 });
    const error = await rejection(hc.serverStatus());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).message).toContain("longer than");
    expect(DEFAULT_MAX_LINE_BYTES).toBeGreaterThan(1_000_000);
  });

  it("refuses a response that is not JSON", async () => {
    const core = await startCore();
    core.handler = (request, socket) => {
      core.write(socket, "not json at all\n");
    };
    const hc = client(core);
    const error = await rejection(hc.serverStatus());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).message).toContain("not JSON");
  });

  it("surfaces an injected connect failure as a transport error naming the socket", async () => {
    const created = createHcClient({
      socket: "/tmp/argos-hc-injected.sock",
      connect: () => {
        throw Object.assign(new Error("cannot create socket"), { code: "EINVAL" });
      },
    });
    clients.push(created);
    expect(created.socket).toBe("/tmp/argos-hc-injected.sock");
    expect(created.endpoint.source).toBe("option");
    const error = await rejection(created.serverStatus());
    expect(error).toBeInstanceOf(HcTransportError);
    expect((error as HcTransportError).message).toContain("/tmp/argos-hc-injected.sock");
  });

  it("round-trips terminal.run/get/list/send/read/rm with hc's own field names", async () => {
    const core = await startCore();
    let live = true;
    const terminal = (): Record<string, unknown> => ({
      address: "t7",
      name: "argos-step",
      state: live ? "live" : "finished",
      status: live
        ? { state: "working", msg: "thinking", title: "step", kind: null, progress: 40 }
        : null,
      turn: 2,
      exit_code: live ? null : 0,
      signal: null,
      reason: live ? null : "exited",
      labels: { "argos/launch": "req-1" },
      argv: ["claude", "do it"],
      cwd: "/work",
      pid: 1234,
      created_ms: 1_700_000_000_000,
      finished_ms: live ? null : 1_700_000_000_500,
      screen: "exact",
      title: "step",
      reported: true,
      template: "claude",
      first_message: { sent: false, started: null, turn: null, reason: "not ready" },
    });
    core.handler = (request, socket) => {
      switch (request.method) {
        case "terminal.run":
          core.respond(socket, request.id, { ...terminal(), output: null });
          return;
        case "terminal.get":
          core.respond(socket, request.id, terminal());
          return;
        case "terminal.list":
          core.respond(socket, request.id, {
            terminals: [terminal()],
            hidden_finished: 1,
            machines: [],
          });
          return;
        case "terminal.send":
          core.respond(socket, request.id, { turn: 2, status: "working", started: true, wait: null });
          return;
        case "terminal.read":
          core.respond(socket, request.id, {
            text: '```json\n{"ok":true}\n```',
            complete: true,
            how: "history",
            why: null,
          });
          return;
        case "terminal.rm":
          live = false;
          core.respond(socket, request.id, { removed: "t7" });
          return;
        default:
          throw new Error(`unexpected method ${request.method}`);
      }
    };
    const hc = client(core);

    const ran = await hc.runTerminal({
      argv: ["claude", "do it"],
      cwd: "/work",
      name: "argos-step",
      labels: { "argos/launch": "req-1" },
      keep: true,
      wait: true,
      timeout: 30,
    });
    expect(ran).toMatchObject({
      address: "t7",
      state: "live",
      turn: 2,
      exit_code: null,
      created_ms: 1_700_000_000_000,
      first_message: { sent: false, reason: "not ready" },
      output: null,
    });
    expect(ran.status).toEqual({
      state: "working",
      msg: "thinking",
      title: "step",
      kind: null,
      progress: 40,
    });
    expect(core.requests[0]?.params).toEqual({
      argv: ["claude", "do it"],
      cwd: "/work",
      name: "argos-step",
      labels: { "argos/launch": "req-1" },
      keep: true,
      wait: true,
      timeout: 30,
    });

    const got = await hc.getTerminal("t7");
    expect(got.labels).toEqual({ "argos/launch": "req-1" });
    expect(core.requests[1]?.params).toEqual({ terminal: "t7" });

    const listed = await hc.listTerminals({ all: true, labels: { "argos/launch": "req-1" } });
    expect(listed).toHaveLength(1);
    expect(core.requests[2]?.params).toEqual({ all: true, labels: { "argos/launch": "req-1" } });

    const sent = await hc.sendText({ terminal: "t7", text: "hello", if: "idle", force: true });
    expect(sent).toEqual({ turn: 2, status: "working", started: true });
    expect(core.requests[3]?.params).toEqual({
      terminal: "t7",
      text: "hello",
      if: "idle",
      force: true,
    });

    const read = await hc.readTerminal("t7", { lines: 50 });
    expect(read.text).toContain("```json");
    expect(read.how).toBe("history");
    expect(core.requests[4]?.params).toEqual({ terminal: "t7", lines: 50 });

    const removed = await hc.removeTerminal("t7");
    expect(removed).toEqual({ removed: "t7" });
  });
});
