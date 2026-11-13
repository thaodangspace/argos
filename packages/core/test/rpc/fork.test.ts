/**
 * `POST /runs/:id/fork` (S-FR1, S-FR12): a real in-process server over a real `ArgosHost`, plain
 * `fetch`, and a temp repo so the fork can genuinely re-load the definition from disk.
 *
 * The interesting assertions are the contract ones: the response shape (a new run), the strict
 * body, and the exact status for each documented code — including `definition_conflict`, which no
 * other route can produce.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import type { RunDetail } from "../../src/rpc/contracts.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, waitForReal } from "../durable/support.js";

const TOKEN = "test-token-0123456789abcdef";

interface Harness {
  readonly repo: string;
  readonly base: string;
  readonly server: RpcServer;
  readonly host: ArgosHost;
  readonly home: ReturnType<typeof makeTempHome>;
}

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness === undefined) continue;
    await harness.server.close();
    await harness.host.close();
    harness.home.cleanup();
    rmSync(harness.repo, { recursive: true, force: true });
  }
});

const BOOK = (stepId = "a", prompt = "Do the work."): string =>
  `title: Fork route
steps:
  - id: ${stepId}
    prompt: "${prompt}"
`;

function writeBook(repo: string, yaml: string): void {
  const dir = join(repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fork.yaml"), yaml, "utf8");
}

async function startHarness(options: { readonly executor?: FakeExecutor } = {}): Promise<Harness> {
  const repo = mkdtempSync(join(tmpdir(), "argos-rpc-fork-"));
  writeBook(repo, BOOK());
  const home = makeTempHome();
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor:
      options.executor ?? new FakeExecutor({ completeAfterPolls: 1, defaultOutcome: "success" }),
  });
  const server = await createRpcServer({
    host,
    home: home.home,
    port: 0,
    token: TOKEN,
  });
  const harness = { repo, base: server.url, server, host, home };
  open.push(harness);
  return harness;
}

async function call(
  base: string,
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token ?? TOKEN}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown) };
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
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

/** Start `fork` in the harness repo and wait for it to finish. */
async function completedParent(harness: Harness): Promise<string> {
  const started = await call(harness.base, "POST", "/runs", {
    body: { playbookId: "fork", cwd: harness.repo },
  });
  expect(started.status).toBe(201);
  const runId = (started.body as { runId: string }).runId;
  await waitForStatus(harness, runId, "completed");
  return runId;
}

describe("POST /runs/:id/fork (S-FR1)", () => {
  it("starts a new run with the reloaded definition and exposes forkedFrom", async () => {
    const harness = await startHarness();
    const parentId = await completedParent(harness);

    writeBook(harness.repo, BOOK("a", "Do the work, then double-check it."));
    const response = await call(harness.base, "POST", `/runs/${parentId}/fork`, {
      body: { stepId: "a" },
    });

    expect(response.status).toBe(201);
    const started = response.body as { runId: string; taskId: string };
    expect(started.runId).not.toBe(parentId);
    expect(typeof started.taskId).toBe("string");

    const detail = await waitForStatus(harness, started.runId, "completed");
    expect(detail.forkedFrom).toEqual({
      runId: parentId,
      stepId: "a",
      fromHash: detail.forkedFrom?.fromHash,
      toHash: detail.playbookHash,
    });
    expect(detail.forkedFrom?.fromHash).not.toBe(detail.playbookHash);
    // The parent's own hash is unchanged by the fork.
    const parent = (await call(harness.base, "GET", `/runs/${parentId}`)).body as RunDetail;
    expect(parent.forkedFrom).toBeUndefined();
    expect(parent.playbookHash).toBe(detail.forkedFrom?.fromHash);
  });

  it("lists the fork with its provenance in GET /runs", async () => {
    const harness = await startHarness();
    const parentId = await completedParent(harness);
    const forked = await call(harness.base, "POST", `/runs/${parentId}/fork`, {
      body: { stepId: "a" },
    });
    const forkedId = (forked.body as { runId: string }).runId;
    await waitForStatus(harness, forkedId, "completed");

    const list = (await call(harness.base, "GET", "/runs")).body as {
      runs: Array<{ id: string; forkedFrom?: { runId: string } }>;
    };
    const entry = list.runs.find((run) => run.id === forkedId);
    expect(entry?.forkedFrom?.runId).toBe(parentId);
    expect(list.runs.find((run) => run.id === parentId)?.forkedFrom).toBeUndefined();
  });

  it("requires a token", async () => {
    const harness = await startHarness();
    const response = await call(harness.base, "POST", "/runs/x/fork", {
      body: { stepId: "a" },
      token: "wrong",
    });
    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("unauthorized");
  });

  it("rejects an extra body key and a missing stepId as invalid_request", async () => {
    const harness = await startHarness();
    const parentId = await completedParent(harness);

    const extra = await call(harness.base, "POST", `/runs/${parentId}/fork`, {
      body: { stepId: "a", reload: true },
    });
    expect(extra.status).toBe(400);
    expect(errorCode(extra.body)).toBe("invalid_request");

    const missing = await call(harness.base, "POST", `/runs/${parentId}/fork`, { body: {} });
    expect(missing.status).toBe(400);
    expect(errorCode(missing.body)).toBe("invalid_request");
  });

  it("answers 405 for a GET", async () => {
    const harness = await startHarness();
    const parentId = await completedParent(harness);
    const response = await call(harness.base, "GET", `/runs/${parentId}/fork`);
    expect(response.status).toBe(405);
    expect(errorCode(response.body)).toBe("method_not_allowed");
  });

  it("maps the refusal codes to their statuses", async () => {
    const harness = await startHarness();
    const parentId = await completedParent(harness);

    const unknown = await call(harness.base, "POST", "/runs/nope/fork", { body: { stepId: "a" } });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe("run_unknown");

    const noStep = await call(harness.base, "POST", `/runs/${parentId}/fork`, {
      body: { stepId: "nope" },
    });
    expect(noStep.status).toBe(404);
    expect(errorCode(noStep.body)).toBe("step_unknown");

    // A renamed step is a different graph: definition_conflict, 409, and nothing new on the list.
    writeBook(harness.repo, BOOK("renamed"));
    const conflict = await call(harness.base, "POST", `/runs/${parentId}/fork`, {
      body: { stepId: "a" },
    });
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict.body)).toBe("definition_conflict");
    const listed = (await call(harness.base, "GET", "/runs")).body as { runs: Array<{ id: string }> };
    expect(listed.runs.map((run) => run.id)).toEqual([parentId]);
  });

  it("refuses a run that is still going with run_terminal", async () => {
    // An executor that never completes keeps the parent parked in `running`.
    const harness = await startHarness({ executor: new FakeExecutor() });
    const started = await call(harness.base, "POST", "/runs", {
      body: { playbookId: "fork", cwd: harness.repo },
    });
    const runId = (started.body as { runId: string }).runId;
    await waitForStatus(harness, runId, "running");

    const response = await call(harness.base, "POST", `/runs/${runId}/fork`, {
      body: { stepId: "a" },
    });
    expect(response.status).toBe(409);
    expect(errorCode(response.body)).toBe("run_terminal");
  });
});
