/**
 * The RPC bridge is what the panel actually uses: it turns the plugin's server calls into the
 * `ArgosRpc` surface, unwraps result envelopes, preserves stable codes, and polls snapshots.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createRpcClientBridge,
  type ArgosRpcCalls,
} from "../shared/rpc-bridge";
import { PluginRpcError } from "../shared/rpc-client";
import type { PluginResult } from "../shared/rpc-api";
import { makeGate, makeRun, makeRunDetail } from "./support.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function calls(overrides: Partial<ArgosRpcCalls> = {}): ArgosRpcCalls {
  const run = makeRun({ id: "run-1", gates: [makeGate({ runId: "run-1", gateId: "gate:1" })] });
  return {
    listRuns: vi.fn<ArgosRpcCalls["listRuns"]>(async () => ({ ok: true, data: [run] })),
    getRun: vi.fn<ArgosRpcCalls["getRun"]>(async () => ({
      ok: true,
      data: makeRunDetail(run),
    })),
    startRun: vi.fn<ArgosRpcCalls["startRun"]>(async () => ({
      ok: true,
      data: { runId: "run-2", taskId: "9" },
    })),
    cancelRun: vi.fn<ArgosRpcCalls["cancelRun"]>(async ({ runId }) => ({
      ok: true,
      data: { runId, status: "cancelled" },
    })),
    removeRun: vi.fn<ArgosRpcCalls["removeRun"]>(async ({ runId }) => ({
      ok: true,
      data: { runId, status: "failed" },
    })),
    retryStep: vi.fn<ArgosRpcCalls["retryStep"]>(async ({ runId }) => ({
      ok: true,
      data: { runId, taskId: "10" },
    })),
    decideGate: vi.fn<ArgosRpcCalls["decideGate"]>(async (input) => ({
      ok: true,
      data: {
        runId: input.runId,
        gateId: input.gateId,
        decision: input.decision,
        decidedAt: 2_000,
      },
    })),
    ...overrides,
  };
}

describe("RPC panel bridge", () => {
  it("unwraps list/detail/decide results and forwards the body", async () => {
    const rpc = calls();
    const bridge = createRpcClientBridge(rpc);

    const runs = await bridge.listRuns();
    expect(runs.map((run) => run.id)).toEqual(["run-1"]);
    expect((await bridge.listGates()).map((gate) => gate.gateId)).toEqual(["gate:1"]);

    const detail = await bridge.getRun("run-1");
    expect(detail.id).toBe("run-1");

    await bridge.decideGate("run-1", "gate:1", { decision: "approve", comment: "lgtm" });
    expect(rpc.decideGate).toHaveBeenCalledWith({
      runId: "run-1",
      gateId: "gate:1",
      decision: "approve",
      comment: "lgtm",
    });

    await bridge.cancelRun("run-1");
    expect(rpc.cancelRun).toHaveBeenCalledWith({ runId: "run-1" });

    await expect(bridge.removeRun("run-1")).resolves.toEqual({ runId: "run-1", status: "failed" });
    expect(rpc.removeRun).toHaveBeenCalledWith({ runId: "run-1" });

    await expect(bridge.retryStep("run-1", "build")).resolves.toEqual({
      runId: "run-1",
      taskId: "10",
    });
    expect(rpc.retryStep).toHaveBeenCalledWith({ runId: "run-1", stepId: "build" });

    bridge.close();
    await expect(bridge.listRuns()).rejects.toMatchObject({ code: "argos_server_closed" });
  });

  it("turns an error envelope into a PluginRpcError with the same code", async () => {
    const rpc = calls({
      decideGate: async () =>
        ({
          ok: false,
          error: { code: "gate_already_decided", message: "already decided", status: 409 },
        }) satisfies PluginResult<never>,
    });
    const bridge = createRpcClientBridge(rpc);

    await expect(
      bridge.decideGate("run-1", "gate:1", { decision: "approve" }),
    ).rejects.toMatchObject({
      name: "PluginRpcError",
      code: "gate_already_decided",
      status: 409,
    });
    await expect(
      bridge.decideGate("run-1", "gate:1", { decision: "approve" }),
    ).rejects.toBeInstanceOf(PluginRpcError);
  });

  it("polls snapshots and stops on close", async () => {
    const rpc = calls();
    const bridge = createRpcClientBridge(rpc, { pollMs: 5 });
    const frames: string[] = [];
    let opened = 0;
    const stream = bridge.openEvents({
      onOpen: () => {
        opened += 1;
      },
      onFrame: (frame) => frames.push(frame.event),
    });

    await wait(25);
    stream.close();
    const count = frames.length;
    await wait(20);
    expect(opened).toBe(1);
    expect(count).toBeGreaterThan(0);
    expect(frames.every((event) => event === "snapshot")).toBe(true);
    expect(frames.length).toBe(count);
    bridge.close();
  });

  it("reports a polling failure once so subscribeRuns can reconnect", async () => {
    let callsMade = 0;
    const rpc = calls({
      listRuns: async () => {
        callsMade += 1;
        if (callsMade === 1) return { ok: true, data: [] };
        return {
          ok: false,
          error: { code: "unauthorized", message: "bad token", status: 401 },
        };
      },
    });
    const bridge = createRpcClientBridge(rpc, { pollMs: 5 });
    const errors: PluginRpcError[] = [];
    const stream = bridge.openEvents({
      onFrame: () => undefined,
      onError: (error) => errors.push(error),
    });

    await wait(25);
    stream.close();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unauthorized");
    bridge.close();
  });
});
