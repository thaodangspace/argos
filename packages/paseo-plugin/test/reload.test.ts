/**
 * Reload test (FR29, plan Phase 9 verification): a plugin instance is torn down while `argos serve`
 * keeps a run going, and a *new* plugin instance reconnects and sees the finished run.
 *
 * This uses the real Phase 8 pieces in process: a real `ArgosHost` over a temp `$ARGOS_HOME` with
 * its own SQLite file, the real `createRpcServer`, and a deterministic in-memory step executor
 * (no Paseo daemon, no model). The executor blocks until the test releases it, so "the panel saw
 * the run advancing" and "the run finished while the plugin was gone" are both exact, not timing
 * races.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentToolDefinition,
  PluginServerContext,
} from "@getpaseo/plugin/server";

import type { ArgosHostOptions } from "argos-core/rpc/server";
import { ArgosHost, createRpcServer, type RpcServer } from "argos-core/rpc/server";

import { createArgosContribution } from "../server/plugin";
import { createArgosClient, type ArgosRpc } from "../shared/rpc-client";
import { createPanel, type PanelStore } from "../shared/panel";
import { fakePluginServer, sessionOpenRequest } from "./support.js";

const PLAYBOOK = `title: Plugin reload
steps:
  - id: draft
    prompt: Draft the change
    poll_ms: 10
  - id: finish
    prompt: Finish the change
    needs: [draft]
    poll_ms: 10
`;

interface Harness {
  readonly home: string;
  readonly repo: string;
  readonly host: ArgosHost;
  readonly server: RpcServer;
  readonly launched: string[];
  release(): void;
}

const openHarnesses: Harness[] = [];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A two-step playbook repo and an in-process server with a manually released executor. */
async function startHarness(): Promise<Harness> {
  const home = tempDir("argos-plugin-home-");
  const repo = tempDir("argos-plugin-repo-");
  mkdirSync(join(repo, ".argos", "playbooks"), { recursive: true });
  writeFileSync(join(repo, ".argos", "playbooks", "reload.yaml"), PLAYBOOK);

  const launched: string[] = [];
  const polls = new Map<string, number>();
  let released = false;
  let nextAgent = 1;

  // Structurally a StepExecutor: launch/inspect only, no daemon.
  const executor = {
    async launch(input: { requestId: string; stepId: string }) {
      launched.push(input.requestId);
      const agentId = `fake-agent-${nextAgent}`;
      nextAgent += 1;
      return { agentId };
    },
    async status(input: { requestId: string; outcomes: readonly string[] }) {
      if (!released) return { state: "running" as const };
      const count = (polls.get(input.requestId) ?? 0) + 1;
      polls.set(input.requestId, count);
      if (count < 2) return { state: "running" as const };
      return {
        state: "done" as const,
        outcome: input.outcomes.includes("success")
          ? "success"
          : (input.outcomes[0] ?? "success"),
      };
    },
  } as unknown as ArgosHostOptions["executor"];

  const host = await ArgosHost.open({ home, executor });
  const server = await createRpcServer({ host, home, port: 0, cwd: repo });
  const harness: Harness = {
    home,
    repo,
    host,
    server,
    launched,
    release: () => {
      released = true;
    },
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.host.close();
    rmSync(harness.home, { recursive: true, force: true });
    rmSync(harness.repo, { recursive: true, force: true });
  }
});

interface PluginInstance {
  readonly client: ArgosRpc;
  readonly panel: PanelStore;
  readonly tools: AgentToolDefinition[];
  readonly cleanup: () => Promise<void>;
}

/** One plugin lifetime: a fresh HTTP client, a panel, and the contribution's teardown. */
async function createPlugin(harness: Harness): Promise<PluginInstance> {
  const client = createArgosClient({ url: harness.server.url, token: harness.server.token });
  const panel = createPanel({ client });
  const fake = fakePluginServer();
  const cleanup = createArgosContribution({ createClient: () => client })(
    fake as unknown as PluginServerContext,
  );
  const opened = await fake.runOpen(sessionOpenRequest());
  const tools = opened["tools"] as AgentToolDefinition[];
  panel.start();
  await panel.load();
  return {
    client,
    panel,
    tools,
    cleanup: async () => {
      panel.dispose();
      await cleanup();
    },
  };
}

function tool(instance: PluginInstance, name: string): AgentToolDefinition {
  const found = instance.tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("plugin reload while a run is active", () => {
  it("stops seeing the run when torn down and sees it completed after a new instance starts", async () => {
    const harness = await startHarness();
    const first = await createPlugin(harness);

    // 1. Start a run through the chat tool (hook → tool → HTTP → host).
    const started = await tool(first, "argos_start_playbook").execute(
      { playbookId: "reload", cwd: harness.repo },
      {
        agent: { id: "agent-1", cwd: harness.repo },
        paseo: {},
        signal: new AbortController().signal,
      } as never,
    );
    const runId = (started.structuredContent as { runId: string }).runId;
    expect(started.isError).toBeUndefined();

    // 2. The panel sees it advancing: running, with the blocking step running and none settled.
    await waitFor(() => first.panel.getModel().runs.length === 1, "the panel snapshot");
    await waitFor(
      () =>
        first.panel.getModel().runs[0]?.steps.some((step) => step.status === "running") === true,
      "the running step to appear in the panel",
    );
    const advancing = first.panel.getModel().runs[0];
    expect(advancing?.id).toBe(runId);
    expect(advancing?.status).toBe("running");
    expect(harness.launched).toHaveLength(1);

    // 3. Tear the plugin down. It closes only its HTTP client; the server keeps the run.
    await first.cleanup();
    expect(first.client.closed).toBe(true);
    await expect(first.client.listRuns()).rejects.toMatchObject({
      code: "argos_server_closed",
    });
    expect(harness.host).toBeDefined();

    // 4. Let the run finish with no plugin attached, then wait for `completed` on the server side.
    harness.release();
    await waitFor(async () => {
      const doc = await harness.host.getRun(runId);
      return doc?.record.status === "completed";
    }, "the run to complete without a plugin");

    const finished = await harness.host.getRun(runId);
    expect(finished?.record.status).toBe("completed");
    // Exactly one launch per step: the run resumed, it did not restart.
    expect(harness.launched).toHaveLength(2);

    // 5. A brand-new plugin instance reconnects and sees the finished run.
    const second = await createPlugin(harness);
    await waitFor(
      () => second.panel.getModel().runs.some((run) => run.id === runId),
      "the reloaded panel to list the run",
    );
    const reloaded = second.panel.getModel().runs.find((run) => run.id === runId);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.steps.every((step) => step.status === "completed")).toBe(true);
    expect(second.panel.getModel().gates).toEqual([]);

    // The tools survived the reload with the same names (no duplicates).
    expect(second.tools.map((entry) => entry.name)).toEqual([
      "argos_start_playbook",
      "argos_run_status",
      "argos_decide_gate",
      "argos_cancel_run",
    ]);

    // `argos_run_status` on the reloaded instance reports the finished run.
    const status = await tool(second, "argos_run_status").execute(
      { runId },
      { agent: { id: "agent-2" }, paseo: {}, signal: new AbortController().signal } as never,
    );
    expect(status.text).toContain("Completed");

    await second.cleanup();
    await vi.waitFor(() => {
      expect(second.client.closed).toBe(true);
    });
  }, 20_000);
});
