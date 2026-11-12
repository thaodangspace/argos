/**
 * `contribute` test (FR28, plan Phase 9 verification): the server half registers one
 * `agent.open.before` hook that adds exactly the four Argos tools, never duplicates them across a
 * second contribution, and tears down by removing the hook and closing **only** the HTTP client.
 */

import { describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  AGENT_OPEN_HOOK,
  createArgosContribution,
} from "../server/plugin";
import { ARGOS_TOOL_NAMES } from "../server/tools";
import {
  ARGOS_SERVER_CLOSED,
  ARGOS_SERVER_UNREACHABLE,
  PluginRpcError,
  createArgosClient,
} from "../shared/rpc-client";
import { fakePluginServer, fakeRpc, makeRun, sessionOpenRequest } from "./support.js";

const EXPECTED_TOOLS = [
  "argos_start_playbook",
  "argos_run_status",
  "argos_decide_gate",
  "argos_cancel_run",
];

function toolNames(request: Record<string, unknown>): string[] {
  const tools = request["tools"] as { name: string }[];
  return tools.map((tool) => tool.name);
}

function asServer(fake: ReturnType<typeof fakePluginServer>): PluginServerContext {
  return fake as unknown as PluginServerContext;
}

describe("contribute (server half)", () => {
  it("exposes the four tool names in a stable order", () => {
    expect([...ARGOS_TOOL_NAMES]).toEqual(EXPECTED_TOOLS);
  });

  it("registers agent.open.before and adds exactly the four tools", async () => {
    const server = fakePluginServer();
    const client = fakeRpc();
    const cleanup = createArgosContribution({ createClient: () => client })(asServer(server));

    expect(server.hooks.map((hook) => hook.name)).toEqual([AGENT_OPEN_HOOK]);

    const opened = await server.runOpen(sessionOpenRequest([{ name: "read_file" }]));
    expect(toolNames(opened)).toEqual(["read_file", ...EXPECTED_TOOLS]);

    await cleanup();
  });

  it("bridges the panel through the tools client with result envelopes", async () => {
    const server = fakePluginServer();
    const run = makeRun({ id: "run-1" });
    const client = fakeRpc({ runs: [run] });
    const cleanup = createArgosContribution({ createClient: () => client })(
      asServer(server),
    );

    await expect(server.runHandler("argos.runs.list", {})).resolves.toEqual({
      ok: true,
      data: [run],
    });
    await expect(server.runHandler("argos.runs.cancel", { runId: "run-1" })).resolves.toEqual({
      ok: true,
      data: { runId: "run-1", status: "cancelled" },
    });
    await expect(server.runHandler("argos.runs.remove", { runId: "run-1" })).resolves.toEqual({
      ok: true,
      data: { runId: "run-1", status: "completed" },
    });
    await expect(
      server.runHandler("argos.gates.decide", {
        runId: "run-1",
        gateId: "gate:1",
        decision: "approve",
      }),
    ).resolves.toMatchObject({ ok: true, data: { decision: "approve" } });

    await cleanup();
  });

  it("keeps a stable Argos code when the server rejects a call", async () => {
    const server = fakePluginServer();
    const client = fakeRpc({
      decideGate: async () => {
        throw new PluginRpcError("gate_already_decided", "already decided", 409);
      },
    });
    const cleanup = createArgosContribution({ createClient: () => client })(
      asServer(server),
    );

    await expect(
      server.runHandler("argos.gates.decide", {
        runId: "run-1",
        gateId: "gate:1",
        decision: "approve",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "gate_already_decided", message: "already decided", status: 409 },
    });

    await cleanup();
  });

  it("replaces a stale Argos tool instead of duplicating it", async () => {
    const server = fakePluginServer();
    const stale = { name: "argos_run_status", title: "old", description: "old", input: {} };
    const cleanup = createArgosContribution({ createClient: () => fakeRpc() })(asServer(server));

    const opened = await server.runOpen(
      sessionOpenRequest([{ name: "read_file" }, stale]),
    );
    expect(toolNames(opened)).toEqual(["read_file", ...EXPECTED_TOOLS]);

    await cleanup();
  });

  it("does not duplicate tools when a second instance contributes and the session opens again", async () => {
    const server = fakePluginServer();
    const first = fakeRpc();
    const second = fakeRpc();
    const cleanups = [
      createArgosContribution({ createClient: () => first })(asServer(server)),
      createArgosContribution({ createClient: () => second })(asServer(server)),
    ];

    expect(server.hooks).toHaveLength(2);
    // Both hooks run on one session open (the daemon applies them in registration order).
    let request = sessionOpenRequest([{ name: "read_file" }]);
    for (const hook of server.hooks) {
      request = (await hook.handler({ request } as never)) as Record<string, unknown>;
    }
    const names = toolNames(request);
    expect(names).toEqual(["read_file", ...EXPECTED_TOOLS]);
    expect(new Set(names).size).toBe(names.length);

    for (const cleanup of cleanups) await cleanup();
  });

  it("tears down by removing its hook and closing only the HTTP client", async () => {
    const server = fakePluginServer();
    const client = fakeRpc();
    const cleanup = createArgosContribution({ createClient: () => client })(asServer(server));

    // One hook for the chat tools and one RPC handler that hands the panel its connection.
    expect(server.calls).toEqual([
      `addHook:${AGENT_OPEN_HOOK}`,
      "handle:argos.runs.list",
      "handle:argos.runs.get",
      "handle:argos.runs.start",
      "handle:argos.runs.cancel",
      "handle:argos.runs.remove",
      "handle:argos.runs.retry",
      "handle:argos.gates.decide",
    ]);

    await cleanup();

    expect(server.removeCount()).toBe(1);
    expect(server.hooks.every((hook) => hook.removed)).toBe(true);
    expect(client.close).toHaveBeenCalledTimes(1);
    // Teardown touched nothing else on the server (no storage, no settings).
    expect(server.calls).toEqual([
      `addHook:${AGENT_OPEN_HOOK}`,
      "handle:argos.runs.list",
      "handle:argos.runs.get",
      "handle:argos.runs.start",
      "handle:argos.runs.cancel",
      "handle:argos.runs.remove",
      "handle:argos.runs.retry",
      "handle:argos.gates.decide",
    ]);

    // Idempotent: a second teardown neither re-removes the hook nor re-closes the client.
    await cleanup();
    expect(server.removeCount()).toBe(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("each contribution closes its own client", async () => {
    const server = fakePluginServer();
    const first = fakeRpc();
    const second = fakeRpc();
    const cleanupFirst = createArgosContribution({ createClient: () => first })(asServer(server));
    const cleanupSecond = createArgosContribution({ createClient: () => second })(asServer(server));

    await cleanupFirst();
    expect(server.removeCount()).toBe(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();

    await cleanupSecond();
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

describe("the plugin's only teardown target is HTTP", () => {
  it("reports an unreachable server, then refuses every call once closed", async () => {
    // Nothing listens on port 9; this exercises the real client, not a fake.
    const client = createArgosClient({ url: "http://127.0.0.1:9", token: "t" });

    await expect(client.listRuns()).rejects.toMatchObject({
      code: ARGOS_SERVER_UNREACHABLE,
      message: expect.stringContaining("Argos server not running"),
    });

    client.close();
    expect(client.closed).toBe(true);
    await expect(client.listRuns()).rejects.toMatchObject({ code: ARGOS_SERVER_CLOSED });

    // Closing twice is safe (teardown after a failed load).
    expect(() => {
      client.close();
    }).not.toThrow();
  });

  it("maps a server error to its stable code, not to 'unreachable'", () => {
    const mapped = PluginRpcError.from(
      Object.assign(new Error("invalid request"), { name: "RpcClientError" }),
    );
    // A non-RpcClientError is internal_error, never a fake server code.
    expect(mapped.code).toBe("internal_error");
    expect(mapped.unreachable).toBe(false);
  });

  it("aborts an open event stream on close", async () => {
    const client = createArgosClient({ url: "http://127.0.0.1:9", token: "t" });
    const onError = vi.fn();
    const stream = client.openEvents({ onFrame: () => undefined, onError });
    stream.close();
    client.close();
    // The fetch was aborted, so no "stream closed" error is reported for a deliberate close.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
