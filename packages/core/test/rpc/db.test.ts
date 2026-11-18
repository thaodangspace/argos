/**
 * `GET /db/stats`, `POST /db/purge`, `POST /db/vacuum` over a real in-process server.
 *
 * Unlike the other RPC suites this one needs a **file-backed** host: the whole point of the routes
 * is the one SQLite connection `argos serve` owns. Each test starts one on a temp home, drives a
 * single-step run to `completed`, and then exercises the maintenance surface.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import {
  DbPurgeResponseSchema,
  DbStatsSchema,
  DbVacuumResponseSchema,
  RunDetailSchema,
  type DbStats,
  type RunDetail,
} from "../../src/rpc/contracts.js";
import { playbook, step } from "../../src/engine/test-util.js";
import type { PlaybookIR } from "../../src/playbook/ir.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, type TempHome } from "../durable/support.js";
import { makeTempRepo, type TempRepo } from "../support/git.js";

const TOKEN = "db-test-token-0123456789";

interface Harness {
  host: ArgosHost;
  server: RpcServer;
  base: string;
  home: TempHome;
  repo: TempRepo;
}

const openHarnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const home = makeTempHome();
  const repo = makeTempRepo();
  const ir = playbook({ id: "one", steps: [step({ id: "a", pollMs: 5, prompt: "Work." })] });
  const dir = join(repo.repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ir.id}.yaml`), renderPlaybook(ir), "utf8");
  repo.git(["add", "-A"]);
  repo.git(["commit", "--quiet", "-m", "playbook one"]);

  const host = await ArgosHost.open({
    home: home.home,
    executor: new FakeExecutor({ completeAfterPolls: 1 }),
  });
  const server = await createRpcServer({ host, home: home.home, port: 0, token: TOKEN });
  const harness = { host, server, base: server.url, home, repo };
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
    harness.repo.cleanup();
  }
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...auth(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown),
  };
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
}

async function waitForCompleted(harness: Harness, runId: string): Promise<RunDetail> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await call(harness.base, "GET", `/runs/${runId}`);
    if (response.status === 200) {
      const detail = RunDetailSchema.parse(response.body);
      if (detail.status === "completed") return detail;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} never completed`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function completedRunId(harness: Harness): Promise<string> {
  const started = await call(harness.base, "POST", "/runs", {
    playbookId: "one",
    cwd: harness.repo.repo,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = (started.body as { runId: string }).runId;
  await waitForCompleted(harness, runId);
  // `updatedAt` must be strictly older than a purge cutoff taken after this point.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return runId;
}

function renderPlaybook(ir: PlaybookIR): string {
  const lines: string[] = [`title: ${JSON.stringify(ir.title)}`, "steps:"];
  for (const entry of ir.steps) {
    lines.push(`  - id: ${JSON.stringify(entry.id)}`);
    if (entry.prompt !== undefined) lines.push(`    prompt: ${JSON.stringify(entry.prompt)}`);
    if (entry.pollMs !== 3_000) lines.push(`    poll_ms: ${entry.pollMs}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("/db routes", () => {
  it("reports stats for the file-backed host", async () => {
    const harness = await startHarness();
    await completedRunId(harness);

    const response = await call(harness.base, "GET", "/db/stats");
    expect(response.status).toBe(200);
    const stats: DbStats = DbStatsSchema.parse(response.body);
    expect(stats.path).toBe(join(harness.home.home, "argos.sqlite"));
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.runs).toEqual({ total: 1, active: 0 });
    expect(stats.tasks.terminal).toBeGreaterThanOrEqual(2);
    expect(stats.documents.byKind.map((kind) => kind.kind)).toContain("argos.run");

    const wrongMethod = await call(harness.base, "POST", "/db/stats");
    expect(wrongMethod.status).toBe(405);
  });

  it("purges a terminal run: dry run first, then for real", async () => {
    const harness = await startHarness();
    const runId = await completedRunId(harness);

    const bad = await call(harness.base, "POST", "/db/purge", { olderThan: "soon" });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.body)).toBe("invalid_request");

    const before = DbStatsSchema.parse((await call(harness.base, "GET", "/db/stats")).body);
    const dry = await call(harness.base, "POST", "/db/purge", {
      olderThan: "0s",
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    const dryBody = DbPurgeResponseSchema.parse(dry.body);
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.removed.map((run) => run.runId)).toEqual([runId]);
    expect(dryBody.tasksRemoved).toBeGreaterThanOrEqual(2);
    expect((await call(harness.base, "GET", `/runs/${runId}`)).status).toBe(200);

    const purged = await call(harness.base, "POST", "/db/purge", { olderThan: "0s" });
    expect(purged.status).toBe(200);
    const body = DbPurgeResponseSchema.parse(purged.body);
    expect(body.removed.map((run) => run.runId)).toEqual([runId]);
    expect(body.vacuumed).toBe(false);
    expect((await call(harness.base, "GET", `/runs/${runId}`)).status).toBe(404);

    const after = DbStatsSchema.parse((await call(harness.base, "GET", "/db/stats")).body);
    expect(after.runs.total).toBe(0);
    expect(after.tasks.total).toBeLessThan(before.tasks.total);
    expect(after.documents.live).toBeLessThan(before.documents.live);
  });

  it("vacuums the database", async () => {
    const harness = await startHarness();
    await completedRunId(harness);
    const response = await call(harness.base, "POST", "/db/vacuum");
    expect(response.status).toBe(200);
    const body = DbVacuumResponseSchema.parse(response.body);
    expect(body.vacuumed).toBe(true);
    expect(body.after.bytes).toBeGreaterThan(0);
  });

  it("answers 404 for an unknown /db path and requires the token", async () => {
    const harness = await startHarness();
    const unknown = await call(harness.base, "GET", "/db/nope");
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe("not_found");

    const unauthorized = await fetch(`${harness.base}/db/stats`);
    expect(unauthorized.status).toBe(401);
  });
});
