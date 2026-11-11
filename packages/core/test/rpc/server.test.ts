/**
 * Phase 8 contract tests (FR26/FR27): a real in-process server, a real `ArgosHost` over
 * `MemoryStorage`, a fake executor, and plain `fetch`. No daemon, no network beyond loopback.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type { Clock } from "../../src/durable/context.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import type { RunDetail, RunSummary, ServerInfo } from "../../src/rpc/contracts.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { FakeExecutor } from "../fakes/executor.js";
import { gatedPlaybook, makeTempHome, waitForReal } from "../durable/support.js";

const TOKEN = "test-token-0123456789abcdef";

/** A clock that changes `now()` but never fires durable timers (D15 TTL tests only). */
class ManualClock implements Clock {
  #now = Date.now();

  now = (): number => this.#now;

  setTimer = (): (() => void) => () => undefined;

  advance(ms: number): void {
    this.#now += ms;
  }
}

interface Harness {
  host: ArgosHost;
  server: RpcServer;
  base: string;
  home: ReturnType<typeof makeTempHome>;
  executor: FakeExecutor;
}

const openHarnesses: Harness[] = [];

async function startHarness(
  executor: FakeExecutor,
  options: { readonly clock?: Clock; readonly enablePaseo?: boolean } = {},
): Promise<Harness> {
  const home = makeTempHome();
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const server = await createRpcServer({
    host,
    home: home.home,
    port: 0,
    token: TOKEN,
    ...(options.enablePaseo === true
      ? {
          paseo: {
            mode: "fake" as const,
            snapshot: async () => ({
              providers: [
                {
                  provider: "claude",
                  enabled: true,
                  models: [{ provider: "claude", id: "opus" }],
                },
              ],
            }),
          },
        }
      : {}),
  });
  const harness = { host, server, base: server.url, home, executor };
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.host.close();
    harness.home.cleanup();
  }
});

function auth(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function call(
  base: string,
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...auth(options.token ?? TOKEN),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown),
    text,
  };
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
}

function singleStepPlaybook(id = "single", prompt = "Do the work."): PlaybookIR {
  return playbook({
    id,
    steps: [
      step({
        id: "a",
        pollMs: 5,
        prompt,
      }),
    ],
  });
}

async function waitForStatus(harness: Harness, runId: string, status: string): Promise<RunDetail> {
  let latest: RunDetail | undefined;
  await waitForReal(async () => {
    const response = await call(harness.base, "GET", `/runs/${runId}`);
    if (response.status !== 200) return false;
    latest = response.body as RunDetail;
    return latest.status === status;
  });
  if (latest === undefined) throw new Error("run never observed");
  return latest;
}

// ------------------------------------------------------------------ SSE reader

interface SseState {
  buffer: string;
}

async function nextSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: SseState,
  timeoutMs = 5_000,
): Promise<{ event: string; data: string }> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  for (;;) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      if (frame.startsWith(":")) continue; // heartbeat / comment
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) data.push(line.slice("data:".length).trim());
      }
      return { event, data: data.join("\n") };
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for an SSE frame");
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE stream ended before a frame arrived");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

// ------------------------------------------------------------------ tests

describe("RPC auth (FR27)", () => {
  it("answers 401 without a token and with a wrong token", async () => {
    const harness = await startHarness(new FakeExecutor());
    const missing = await fetch(`${harness.base}/runs`);
    expect(missing.status).toBe(401);
    expect(errorCode(await missing.json())).toBe("unauthorized");

    const wrong = await fetch(`${harness.base}/runs`, {
      headers: auth("definitely-not-the-token"),
    });
    expect(wrong.status).toBe(401);
    expect(errorCode(await wrong.json())).toBe("unauthorized");

    const health = await call(harness.base, "GET", "/health");
    expect(health.status).toBe(200);
    expect((health.body as { status: string }).status).toBe("ok");
  });
});

describe("POST /runs (FR26, D15)", () => {
  it("creates exactly one run for one clientRequestId", async () => {
    const executor = new FakeExecutor();
    const harness = await startHarness(executor);
    const body = {
      playbookId: "single",
      inputs: { issue: "42" },
      clientRequestId: "req-1",
      cwd: process.cwd(),
    };

    // The loader needs a real repository: point `cwd` at a temp playbook tree.
    const repo = await makeRepoWith(singleStepPlaybook());
    const first = await call(harness.base, "POST", "/runs", {
      body: { ...body, cwd: repo },
    });
    expect(first.status).toBe(201);
    const firstBody = first.body as { runId: string; taskId: string };
    expect(firstBody.runId).not.toBe("");

    const second = await call(harness.base, "POST", "/runs", {
      body: { ...body, cwd: repo },
    });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(firstBody);

    const list = await call(harness.base, "GET", "/runs");
    expect((list.body as { runs: RunSummary[] }).runs).toHaveLength(1);

    const inspect = await harness.host.inspect();
    const runTasks = inspect.tasks.filter((task) => task.record.kind === "argos.run");
    expect(runTasks).toHaveLength(1);

    // D15 also stores the request id in the run checkpoint.
    const record = await harness.host.getTaskRecord(firstBody.taskId);
    const checkpoint = record?.state.checkpoint as unknown as
      | { lastClientRequestId?: string }
      | undefined;
    expect(checkpoint?.lastClientRequestId).toBe("req-1");
  });

  it("starts a new run once the 24 h idempotency window has passed", async () => {
    const clock = new ManualClock();
    const executor = new FakeExecutor();
    const harness = await startHarness(executor, { clock });
    const repo = await makeRepoWith(singleStepPlaybook());
    const body = { playbookId: "single", cwd: repo, clientRequestId: "ttl-1" };

    const first = (await call(harness.base, "POST", "/runs", { body })).body as {
      runId: string;
      taskId: string;
    };
    const repeated = (await call(harness.base, "POST", "/runs", { body })).body as {
      runId: string;
    };
    expect(repeated.runId).toBe(first.runId);

    await clock.advance(24 * 60 * 60 * 1000 + 1_000);    const afterTtl = (await call(harness.base, "POST", "/runs", { body })).body as {
      runId: string;
    };
    expect(afterTtl.runId).not.toBe(first.runId);
    const list = await call(harness.base, "GET", "/runs");
    expect((list.body as { runs: RunSummary[] }).runs).toHaveLength(2);
  });

  it("refuses an invalid playbook before creating a task", async () => {
    const harness = await startHarness(new FakeExecutor());
    const repo = await makeRepoWithText("broken.yaml", "title: broken\nsteps:\n  - id: a\n");
    const response = await call(harness.base, "POST", "/runs", {
      body: { playbookId: "broken", cwd: repo },
    });
    expect(response.status).toBe(422);
    expect(errorCode(response.body)).toBe("playbook_invalid");
    expect(response.text).toContain("broken.yaml");
    expect(response.text).toContain("step a");
    const list = await call(harness.base, "GET", "/runs");
    expect((list.body as { runs: RunSummary[] }).runs).toHaveLength(0);
  });
});

describe("GET /runs (FR26)", () => {
  it("returns a summary without prompts or transcripts", async () => {
    const secretPrompt = "TOP-SECRET-PROMPT-6a1f0c";
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const harness = await startHarness(executor);
    const repo = await makeRepoWith(singleStepPlaybook("single", secretPrompt));

    const started = (await call(harness.base, "POST", "/runs", {
      body: { playbookId: "single", cwd: repo, inputs: {} },
    })).body as { runId: string };
    const detail = await waitForStatus(harness, started.runId, "completed");

    const list = await call(harness.base, "GET", "/runs");
    expect(list.status).toBe(200);
    const runs = (list.body as { runs: RunSummary[] }).runs;
    expect(runs).toHaveLength(1);
    const run = runs[0] as RunSummary;
    expect(run.steps).toEqual([
      expect.objectContaining({ id: "a", status: "completed", attemptCount: 1, kind: "agent" }),
    ]);
    expect(run).not.toHaveProperty("ir");
    expect(run).not.toHaveProperty("history");
    expect(list.text.toLowerCase()).not.toContain("prompt");
    expect(list.text.toLowerCase()).not.toContain("transcript");
    expect(list.text).not.toContain(secretPrompt);
    expect(detail.steps[0]).not.toHaveProperty("prompt");
  });
});

describe("GET /events (FR26)", () => {
  it("streams a snapshot and then changed runs", async () => {
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const harness = await startHarness(executor);
    const repo = await makeRepoWith(singleStepPlaybook());

    const controller = new AbortController();
    const response = await fetch(`${harness.base}/events`, {
      headers: auth(),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no SSE body");
    const state: SseState = { buffer: "" };

    const snapshot = await nextSseEvent(reader, state);
    expect(snapshot.event).toBe("snapshot");
    expect((JSON.parse(snapshot.data) as { runs: RunSummary[] }).runs).toEqual([]);

    const started = (await call(harness.base, "POST", "/runs", {
      body: { playbookId: "single", cwd: repo },
    })).body as { runId: string };

    const frame = await nextSseEvent(reader, state);
    expect(frame.event).toBe("run");
    const summary = JSON.parse(frame.data) as RunSummary;
    expect(summary.id).toBe(started.runId);

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("cancel / retry / gates (FR26)", () => {
  it("cancels a live run and refuses a finished one", async () => {
    const executor = new FakeExecutor();
    const harness = await startHarness(executor);
    const repo = await makeRepoWith(singleStepPlaybook());
    const started = (await call(harness.base, "POST", "/runs", {
      body: { playbookId: "single", cwd: repo },
    })).body as { runId: string };

    await waitForReal(async () => {
      const response = await call(harness.base, "GET", `/runs/${started.runId}`);
      return (response.body as RunDetail).steps[0]?.status === "running";
    });

    const cancelled = await call(harness.base, "POST", `/runs/${started.runId}/cancel`, {
      body: {},
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { status: string }).status).toBe("cancelled");

    const again = await call(harness.base, "POST", `/runs/${started.runId}/cancel`, {
      body: {},
    });
    expect(again.status).toBe(409);
    expect(errorCode(again.body)).toBe("run_terminal");

    const unknown = await call(harness.base, "POST", "/runs/nope/cancel", { body: {} });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe("run_unknown");
  });

  it("retries a failed step in a fresh task with the same runId", async () => {
    const executor = new FakeExecutor({
      complete: (agent) => (agent.attempt === 1 ? { errorCode: "step_failed" } : {}),
    });
    const harness = await startHarness(executor);
    const repo = await makeRepoWith(singleStepPlaybook());
    const started = (await call(harness.base, "POST", "/runs", {
      body: { playbookId: "single", cwd: repo },
    })).body as { runId: string; taskId: string };

    await waitForStatus(harness, started.runId, "failed");

    const retried = await call(harness.base, "POST", `/runs/${started.runId}/retry`, {
      body: { stepId: "a" },
    });
    expect(retried.status).toBe(201);
    const retryBody = retried.body as { runId: string; taskId: string };
    expect(retryBody.runId).toBe(started.runId);
    expect(retryBody.taskId).not.toBe(started.taskId);

    const completed = await waitForStatus(harness, started.runId, "completed");
    expect(completed.steps[0]?.attemptCount).toBe(2);
    expect(completed.history.some((event) => event.type === "retry")).toBe(true);

    const missingStep = await call(harness.base, "POST", `/runs/${started.runId}/retry`, {
      body: { stepId: "nope" },
    });
    expect(missingStep.status).toBe(404);
    expect(errorCode(missingStep.body)).toBe("step_unknown");
  });

  it("decides a gate once and treats an identical client request as a replay", async () => {
    const executor = new FakeExecutor({ completeAfterPolls: 1 });
    const harness = await startHarness(executor, { enablePaseo: true });
    const repo = await makeRepoWith(gatedPlaybook());
    const started = (await call(harness.base, "POST", "/runs", {
      body: { playbookId: "gated", cwd: repo },
    })).body as { runId: string };

    let detail: RunDetail | undefined;
    await waitForReal(async () => {
      const response = await call(harness.base, "GET", `/runs/${started.runId}`);
      detail = response.body as RunDetail;
      return detail.gates.some((gate) => gate.status === "pending");
    });
    const pending = detail?.gates.find((gate) => gate.status === "pending");
    expect(pending?.gateId).toBe("review:1");

    const info = (await call(harness.base, "GET", "/info")).body as ServerInfo;
    expect(info.pendingGates).toHaveLength(1);
    expect(info.providers[0]?.provider).toBe("claude");
    expect(info.paseo.reachable).toBe(true);
    expect(info.schemaVersion).toBe(1);

    const decision = {
      decision: "approve",
      comment: "ship it",
      clientRequestId: "gate-req-1",
    };
    const first = await call(
      harness.base,
      "POST",
      `/runs/${started.runId}/gates/${pending?.gateId}`,
      { body: decision },
    );
    expect(first.status).toBe(200);
    expect((first.body as { decision: string }).decision).toBe("approve");

    const replay = await call(
      harness.base,
      "POST",
      `/runs/${started.runId}/gates/${pending?.gateId}`,
      { body: decision },
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const conflict = await call(
      harness.base,
      "POST",
      `/runs/${started.runId}/gates/${pending?.gateId}`,
      { body: { decision: "revise" } },
    );
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict.body)).toBe("gate_already_decided");

    const unknownGate = await call(
      harness.base,
      "POST",
      `/runs/${started.runId}/gates/review:9`,
      { body: { decision: "approve" } },
    );
    expect(unknownGate.status).toBe(404);
    expect(errorCode(unknownGate.body)).toBe("gate_unknown");

    const completed = await waitForStatus(harness, started.runId, "completed");
    expect(completed.gates[0]?.status).toBe("decided");
    expect(completed.gates[0]?.decision).toBe("approve");
  });

  it("answers 404 for an unknown run", async () => {
    const harness = await startHarness(new FakeExecutor());
    const response = await call(harness.base, "GET", "/runs/nope");
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe("run_unknown");
  });
});

// ------------------------------------------------------------------ helpers

/** Write a playbook IR into a temp repo as `.argos/playbooks/<id>.yaml`. */
async function makeRepoWith(ir: PlaybookIR): Promise<string> {
  const directory = makeTempHome();
  const playbookDir = join(directory.home, ".argos", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  writeFileSync(join(playbookDir, `${ir.id}.yaml`), renderPlaybook(ir), "utf8");
  return registerRepo(directory);
}

async function makeRepoWithText(name: string, yaml: string): Promise<string> {
  const directory = makeTempHome();
  const playbookDir = join(directory.home, ".argos", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  writeFileSync(join(playbookDir, name), yaml, "utf8");
  return registerRepo(directory);
}

const repos: Array<ReturnType<typeof makeTempHome>> = [];
function registerRepo(repo: ReturnType<typeof makeTempHome>): string {
  repos.push(repo);
  return repo.home;
}

afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

/** Minimal YAML rendering of the IR subset the tests create (no sub-playbooks/roles). */
function renderPlaybook(ir: PlaybookIR): string {
  const lines: string[] = [`title: ${JSON.stringify(ir.title)}`, "steps:"];
  for (const step of ir.steps) {
    lines.push(`  - id: ${JSON.stringify(step.id)}`);
    if (step.title !== step.id) lines.push(`    title: ${JSON.stringify(step.title)}`);
    if (step.prompt !== undefined) lines.push(`    prompt: ${JSON.stringify(step.prompt)}`);
    if (step.kind !== "agent") lines.push(`    kind: ${step.kind}`);
    if (step.kind === "gate" && step.gate !== undefined) {
      lines.push("    gate:");
      lines.push(`      question: ${JSON.stringify(step.gate.question)}`);
      lines.push("      choices:");
      for (const [id, choice] of Object.entries(step.gate.choices)) {
        lines.push(`        ${id}:`);
        lines.push(`          label: ${JSON.stringify(choice.label)}`);
        lines.push(`          comment: ${choice.comment}`);
      }
    }
    if (step.needs.length > 0) lines.push(`    needs: [${step.needs.join(", ")}]`);
    if (step.pollMs !== 3_000) lines.push(`    poll_ms: ${step.pollMs}`);
  }
  return `${lines.join("\n")}\n`;
}
