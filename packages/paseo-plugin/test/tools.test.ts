/**
 * Chat-tool test (FR28, plan Phase 9 verification): the four tools have the exact names, validate
 * with the RPC contract's schemas, call the contract once, and turn failures into
 * `{ isError: true, structuredContent: { error: { code, message } } }` instead of throwing.
 */

import { describe, expect, it } from "vitest";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";

import { ARGOS_TOOL_NAMES, argosTools, appendArgosTools } from "../server/tools";
import { ARGOS_SERVER_UNREACHABLE, PluginRpcError } from "../shared/rpc-client";
import { fakeRpc, makeGate, makeRun, makeRunDetail, makeStep } from "./support.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function byName(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

async function run(
  tools: AgentToolDefinition[],
  name: string,
  input: unknown,
  agentCwd = "/repo",
): Promise<{ text?: string; structuredContent?: unknown; isError?: boolean }> {
  return byName(tools, name).execute(input, {
    agent: { id: "agent-1", cwd: agentCwd },
    paseo: {},
    signal: new AbortController().signal,
  } as never);
}

describe("tool registration", () => {
  it("registers exactly the four FR28 tool names", () => {
    const tools = argosTools(fakeRpc());
    expect(tools.map((tool) => tool.name)).toEqual([
      "argos_start_playbook",
      "argos_run_status",
      "argos_decide_gate",
      "argos_cancel_run",
    ]);
    expect([...ARGOS_TOOL_NAMES]).toEqual(tools.map((tool) => tool.name));
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.input.safeParse).toBe("function");
    }
  });

  it("validates inputs with the contract's zod schema (strict, required ids)", () => {
    const tools = argosTools(fakeRpc());
    const start = byName(tools, "argos_start_playbook").input;
    expect(start.safeParse({ playbookId: "demo" }).success).toBe(true);
    expect(start.safeParse({ playbookId: "demo", inputs: { ticket: "A-1" } }).success).toBe(true);
    expect(start.safeParse({ playbookId: "demo", inputs: { ticket: "A-1" } }).success).toBe(true);
    expect(start.safeParse({}).success).toBe(false);
    expect(start.safeParse({ playbookId: "demo", typo: true }).success).toBe(false);

    expect(byName(tools, "argos_run_status").input.safeParse({ runId: "run-1" }).success).toBe(true);
    expect(byName(tools, "argos_run_status").input.safeParse({}).success).toBe(false);

    const decide = byName(tools, "argos_decide_gate").input;
    expect(
      decide.safeParse({ runId: "run-1", gateId: "review:1", decision: "approve" }).success,
    ).toBe(true);
    expect(decide.safeParse({ runId: "run-1", decision: "approve" }).success).toBe(false);
    expect(decide.safeParse({ runId: "run-1", gateId: "review:1", decision: "" }).success).toBe(false);

    expect(byName(tools, "argos_cancel_run").input.safeParse({ runId: "run-1" }).success).toBe(true);
  });

  it("dedupes by name when appending to an existing session", () => {
    const tools = argosTools(fakeRpc());
    const existing: AgentToolDefinition[] = [
      { name: "read_file", title: "R", description: "read", input: tools[0]!.input, execute: async () => ({}) },
      { name: "argos_run_status", title: "old", description: "old", input: tools[0]!.input, execute: async () => ({}) },
    ];
    const merged = appendArgosTools(existing, tools);
    expect(merged.map((tool) => tool.name)).toEqual(["read_file", ...ARGOS_TOOL_NAMES]);
    expect(new Set(merged.map((tool) => tool.name)).size).toBe(merged.length);
  });
});

describe("argos_start_playbook", () => {
  it("starts the run and returns the run id", async () => {
    const client = fakeRpc();
    const result = await run(argosTools(client), "argos_start_playbook", {
      playbookId: "demo",
      inputs: { ticket: "A-1" },
      cwd: "/repo",
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ runId: "run-new", taskId: "42" });
    expect(result.text).toContain("run-new");
    expect(client.startRun).toHaveBeenCalledTimes(1);
    const body = client.startRun.mock.calls[0]?.[0];
    expect(body).toMatchObject({ playbookId: "demo", inputs: { ticket: "A-1" }, cwd: "/repo" });
    expect(body?.clientRequestId).toMatch(UUID);
  });

  it("keeps an explicit clientRequestId (D15 idempotency)", async () => {
    const client = fakeRpc();
    await run(argosTools(client), "argos_start_playbook", {
      playbookId: "demo",
      clientRequestId: "request-1",
    });
    expect(client.startRun.mock.calls[0]?.[0]?.clientRequestId).toBe("request-1");
  });

  it("defaults cwd to the calling agent's working directory (FR6.2)", async () => {
    const client = fakeRpc();
    const result = await run(argosTools(client), "argos_start_playbook", { playbookId: "demo" });

    expect(result.isError).toBeUndefined();
    expect(client.startRun).toHaveBeenCalledTimes(1);
    expect(client.startRun.mock.calls[0]?.[0]?.cwd).toBe("/repo");
  });

  it("allows a subdirectory of the calling agent's working directory", async () => {
    const client = fakeRpc();
    const result = await run(argosTools(client), "argos_start_playbook", {
      playbookId: "demo",
      cwd: "/repo/packages/core",
    });

    expect(result.isError).toBeUndefined();
    expect(client.startRun.mock.calls[0]?.[0]?.cwd).toBe("/repo/packages/core");
  });

  it("refuses a cwd outside the agent cwd without calling the server", async () => {
    for (const cwd of ["/other", "/repo2", "/repo/../x"]) {
      const client = fakeRpc();
      const result = await run(argosTools(client), "argos_start_playbook", {
        playbookId: "demo",
        cwd,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
      expect(client.startRun).not.toHaveBeenCalled();
    }
  });

  it("refuses when the calling agent has no working directory", async () => {
    const client = fakeRpc();
    const result = await run(
      argosTools(client),
      "argos_start_playbook",
      { playbookId: "demo" },
      "",
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it("returns playbook_invalid (isError) for a server 422, never a raw throw", async () => {
    const client = fakeRpc();
    client.startRun.mockRejectedValueOnce(
      new PluginRpcError(
        "playbook_invalid",
        "playbook demo: step implement declares unknown outcome done",
        422,
      ),
    );

    const result = await run(argosTools(client), "argos_start_playbook", { playbookId: "demo" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "playbook_invalid",
        message: "playbook demo: step implement declares unknown outcome done",
      },
    });
  });

  it("collapses playbook_cycle / playbook_missing into playbook_invalid", async () => {
    for (const code of ["playbook_cycle", "playbook_missing"]) {
      const client = fakeRpc();
      client.startRun.mockRejectedValueOnce(new PluginRpcError(code, `${code} detail`, 422));
      const result = await run(argosTools(client), "argos_start_playbook", { playbookId: "demo" });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
        "playbook_invalid",
      );
    }
  });

  it("keeps a server invalid_request as invalid_request (D4)", async () => {
    const client = fakeRpc();
    client.startRun.mockRejectedValueOnce(
      new PluginRpcError("invalid_request", 'cwd "/repo" does not exist', 400),
    );

    const result = await run(argosTools(client), "argos_start_playbook", { playbookId: "demo" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "invalid_request", message: 'cwd "/repo" does not exist' },
    });
  });

  it("reports a stopped server as argos_server_unreachable", async () => {
    const client = fakeRpc();
    client.startRun.mockRejectedValueOnce(
      new PluginRpcError(ARGOS_SERVER_UNREACHABLE, "Argos server not running (start it with `argos serve`)", 0),
    );
    const result = await run(argosTools(client), "argos_start_playbook", { playbookId: "demo" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: ARGOS_SERVER_UNREACHABLE },
    });
    expect(result.text).toContain("Argos server not running");
  });
});

describe("argos_run_status", () => {
  it("renders statuses and pending gate choices without prompts", async () => {
    const summary = makeRun({
      id: "run-1",
      status: "waiting",
      steps: [
        makeStep({ id: "draft", title: "Draft", status: "completed", attemptCount: 1 }),
        makeStep({ id: "review", title: "Review", kind: "gate", status: "waiting" }),
      ],
      gates: [makeGate({ gateId: "review:1", runId: "run-1" })],
    });
    const client = fakeRpc({ detail: makeRunDetail(summary) });

    const result = await run(argosTools(client), "argos_run_status", { runId: "run-1" });

    expect(client.getRun).toHaveBeenCalledTimes(1);
    expect(client.getRun).toHaveBeenCalledWith("run-1");
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("run run-1 · demo · Waiting for gate");
    expect(result.text).toContain("- Draft [draft] · Completed");
    expect(result.text).toContain("gate review:1 on step review: Ship it? → approve (Approve) | reject (Reject)");
    // No prompt/transcript field exists on the contract, so none can leak.
    expect(result.text).not.toMatch(/prompt/i);
    expect(result.structuredContent).toMatchObject({
      run: { id: "run-1", status: "waiting" },
      history: [],
    });
  });

  it("returns run_unknown (isError) for an unknown run", async () => {
    const client = fakeRpc();
    client.getRun.mockRejectedValueOnce(new PluginRpcError("run_unknown", 'unknown run "nope"', 404));
    const result = await run(argosTools(client), "argos_run_status", { runId: "nope" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "run_unknown" } });
  });
});

describe("argos_decide_gate", () => {
  it("decides exactly once with the comment", async () => {
    const client = fakeRpc();
    const result = await run(argosTools(client), "argos_decide_gate", {
      runId: "run-1",
      gateId: "review:1",
      decision: "approve",
      comment: "looks good",
    });

    expect(client.decideGate).toHaveBeenCalledTimes(1);
    expect(client.decideGate).toHaveBeenCalledWith("run-1", "review:1", {
      decision: "approve",
      comment: "looks good",
    });
    expect(result.isError).toBeUndefined();
    expect(result.text).toBe("decided gate review:1 on run run-1: approve");
    expect(result.structuredContent).toMatchObject({ runId: "run-1", gateId: "review:1" });
  });

  it("reports gate_already_decided without retrying", async () => {
    const client = fakeRpc();
    client.decideGate.mockRejectedValueOnce(
      new PluginRpcError("gate_already_decided", "gate review:1 was already decided (reject)", 409),
    );
    const result = await run(argosTools(client), "argos_decide_gate", {
      runId: "run-1",
      gateId: "review:1",
      decision: "approve",
    });
    expect(client.decideGate).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "gate_already_decided" },
    });
  });
});

describe("argos_cancel_run", () => {
  it("cancels exactly once and reports the reached status", async () => {
    const client = fakeRpc();
    const result = await run(argosTools(client), "argos_cancel_run", { runId: "run-1" });
    expect(client.cancelRun).toHaveBeenCalledTimes(1);
    expect(client.cancelRun).toHaveBeenCalledWith("run-1");
    expect(result.isError).toBeUndefined();
    expect(result.text).toBe("run run-1 is cancelled");
    expect(result.structuredContent).toEqual({ runId: "run-1", status: "cancelled" });
  });

  it("reports run_terminal for a finished run", async () => {
    const client = fakeRpc();
    client.cancelRun.mockRejectedValueOnce(
      new PluginRpcError("run_terminal", "run run-1 is already completed", 409),
    );
    const result = await run(argosTools(client), "argos_cancel_run", { runId: "run-1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "run_terminal" } });
  });
});
