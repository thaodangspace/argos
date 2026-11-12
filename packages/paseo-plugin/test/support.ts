/**
 * Test support for the plugin suite: builders for the RPC read model and a fake client/server.
 *
 * No Paseo daemon, no network. The reload test uses the real in-process `argos serve` (see
 * `reload.test.ts`); everything else uses these fakes so a failure is a logic failure.
 */

import { vi } from "vitest";

import type {
  GateSummary,
  RunDetail,
  RunSummary,
  StepSummary,
} from "argos-core/rpc";

import {
  PluginRpcError,
  type ArgosRpc,
  type EventStreamHandle,
  type OpenEvents,
  type SseFrame,
  type SseHandlers,
} from "../shared/rpc-client";

// ------------------------------------------------------------------ builders

export function makeStep(overrides: Partial<StepSummary> & { id: string }): StepSummary {
  return {
    title: overrides.id,
    kind: "agent",
    status: "pending",
    attemptCount: 0,
    ...overrides,
  };
}

export function makeGate(overrides: Partial<GateSummary> & { gateId: string }): GateSummary {
  return {
    runId: "run-1",
    stepId: "review",
    kind: "step",
    question: "Ship it?",
    choices: {
      approve: { label: "Approve", comment: "optional" },
      reject: { label: "Reject", comment: "required", color: "danger" },
    },
    status: "pending",
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    playbookId: "demo",
    playbookHash: "hash-1",
    status: "running",
    inputs: {},
    cwd: "/repo",
    steps: [makeStep({ id: "draft", status: "completed", attemptCount: 1 })],
    gates: [],
    after: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    seq: 1,
    ...overrides,
  };
}

export function makeRunDetail(run: RunSummary, history: RunDetail["history"] = []): RunDetail {
  return { ...run, history };
}

// ------------------------------------------------------------------ fake client

export interface FakeRpcOptions {
  readonly runs?: RunSummary[];
  readonly detail?: RunDetail;
  readonly startRun?: ArgosRpc["startRun"];
  readonly decideGate?: ArgosRpc["decideGate"];
  readonly cancelRun?: ArgosRpc["cancelRun"];
  readonly openEvents?: OpenEvents;
  readonly close?: () => void;
}

export interface FakeRpc extends ArgosRpc {
  readonly listRuns: ReturnType<typeof vi.fn<ArgosRpc["listRuns"]>>;
  readonly getRun: ReturnType<typeof vi.fn<ArgosRpc["getRun"]>>;
  readonly decideGate: ReturnType<typeof vi.fn<ArgosRpc["decideGate"]>>;
  readonly startRun: ReturnType<typeof vi.fn<ArgosRpc["startRun"]>>;
  readonly cancelRun: ReturnType<typeof vi.fn<ArgosRpc["cancelRun"]>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
}

export const NOOP_STREAM: OpenEvents = () => ({ close: () => undefined });

/**
 * An `ArgosRpc` whose every call is a `vi.fn`. `runs` is the whole list `listRuns` returns; a
 * pending gate is derived from it exactly like the panel does.
 */
export function fakeRpc(options: FakeRpcOptions = {}): FakeRpc {
  const runs = options.runs ?? [];
  const listRuns = vi.fn<ArgosRpc["listRuns"]>(async () => runs);
  const getRun = vi.fn<ArgosRpc["getRun"]>(async (runId: string) => {
    if (options.detail !== undefined) return options.detail;
    const found = runs.find((run) => run.id === runId);
    if (found === undefined) {
      throw new PluginRpcError("run_unknown", `unknown run "${runId}"`, 404);
    }
    return makeRunDetail(found);
  });
  const decideGate = vi.fn<ArgosRpc["decideGate"]>(
    options.decideGate ??
      (async (runId, gateId, body) => ({
        runId,
        gateId,
        decision: body.decision,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        decidedAt: 2_000,
      })),
  );
  const startRun = vi.fn<ArgosRpc["startRun"]>(
    options.startRun ?? (async () => ({ runId: "run-new", taskId: "42" })),
  );
  const cancelRun = vi.fn<ArgosRpc["cancelRun"]>(
    options.cancelRun ?? (async (runId: string) => ({ runId, status: "cancelled" as const })),
  );
  const close = vi.fn<() => void>(options.close ?? (() => undefined));
  const openEvents = options.openEvents ?? NOOP_STREAM;

  return {
    url: "http://127.0.0.1:7676",
    home: "/tmp/argos-home",
    closed: false,
    listRuns,
    getRun,
    listGates: vi.fn<ArgosRpc["listGates"]>(async () =>
      runs.flatMap((run) => run.gates.filter((gate) => gate.status === "pending")),
    ),
    decideGate,
    startRun,
    cancelRun,
    openEvents,
    close,
  } as unknown as FakeRpc;
}

// ------------------------------------------------------------------ fake event stream

export interface FakeStream {
  readonly openEvents: OpenEvents;
  /** Handlers of the most recent (or the only) connection. */
  readonly handlers: SseHandlers;
  readonly opened: number;
  /** Simulate the server dropping the stream. */
  drop(error?: PluginRpcError): void;
  readonly closed: number;
  push(event: string, payload: unknown): void;
}

/** A controllable `GET /events`: tests push frames and drop the stream. */
export function fakeStream(): FakeStream {
  const connections: SseHandlers[] = [];
  let closedCount = 0;
  let openedCount = 0;
  const openEvents: OpenEvents = (handlers) => {
    openedCount += 1;
    connections.push(handlers);
    const handle: EventStreamHandle = {
      close: () => {
        closedCount += 1;
      },
    };
    handlers.onOpen?.();
    return handle;
  };
  const current = (): SseHandlers => {
    const entry = connections[connections.length - 1];
    if (entry === undefined) throw new Error("no open stream");
    return entry;
  };
  return {
    openEvents,
    get handlers() {
      return current();
    },
    get opened() {
      return openedCount;
    },
    get closed() {
      return closedCount;
    },
    drop: (error) => {
      current().onError?.(
        error ?? new PluginRpcError("argos_server_unreachable", "lost", 0),
      );
    },
    push: (event, payload) => {
      const frame: SseFrame = { event, data: JSON.stringify(payload) };
      current().onFrame(frame);
    },
  };
}

// ------------------------------------------------------------------ fake plugin server

type HookHandler = (payload: never) => Promise<unknown>;

export interface FakeHook {
  readonly name: string;
  run(payload: unknown): Promise<unknown>;
}

export interface FakePluginServer {
  /** Every `addHook` call, in order, with a live/removed flag. */
  readonly hooks: { name: string; handler: HookHandler; removed: boolean }[];
  readonly calls: string[];
  /** Calls the hook handler the plugin registered (the last still-registered one). */
  runOpen(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Calls a registered plugin RPC handler by contract name. */
  runHandler(name: string, input?: unknown): Promise<unknown>;
  readonly removeCount: () => number;
}

/** Minimal `PluginServerContext`: only `addHook` is real; every other member records its name. */
export function fakePluginServer(): FakePluginServer {
  const hooks: { name: string; handler: HookHandler; removed: boolean }[] = [];
  const handlers = new Map<string, (input: unknown) => unknown>();
  const calls: string[] = [];
  let removals = 0;
  const server = {
    addHook(name: string, handler: HookHandler) {
      calls.push(`addHook:${name}`);
      const entry = { name, handler, removed: false };
      hooks.push(entry);
      return () => {
        removals += 1;
        entry.removed = true;
      };
    },
    handle(contract: { readonly name: string }, handler: (input: unknown) => unknown) {
      calls.push(`handle:${contract.name}`);
      handlers.set(contract.name, handler);
    },
    registerSettings() {
      calls.push("registerSettings");
      throw new Error("the Argos plugin registers no settings");
    },
    registerProvider() {
      calls.push("registerProvider");
    },
    registerUsageSource() {
      calls.push("registerUsageSource");
    },
    on() {
      calls.push("on");
      return () => undefined;
    },
    before() {
      calls.push("before");
      return () => undefined;
    },
  };
  return {
    ...server,
    hooks,
    calls,
    removeCount: () => removals,
    runOpen: async (request) => {
      const entry = [...hooks].reverse().find((hook) => !hook.removed);
      if (entry === undefined) throw new Error("no registered agent.open.before hook");
      return (await entry.handler({ request } as never)) as Record<string, unknown>;
    },
    runHandler: async (name, input) => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`no registered handler for ${name}`);
      return await handler(input);
    },
  } as FakePluginServer;
}

/** A session-open request with the fields the hook reads. */
export function sessionOpenRequest(
  tools: readonly { name: string }[] = [],
): Record<string, unknown> {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    provider: "claude",
    cwd: "/repo",
    reason: "create",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [...tools],
    env: {},
    mcpServers: [],
  };
}
