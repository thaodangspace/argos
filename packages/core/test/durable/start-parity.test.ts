/**
 * Phase 3 (FR4.1, FR2.4): `POST /runs` and the schedule start path are one path.
 *
 * Every case runs the **same** request twice — once through the real RPC server (`POST /runs`) and
 * once through `resolveRunRequest` + `ArgosHost.startRun` on a second host with the same clock — and
 * asserts that the receipt, the mirrored record, the `run_started` history detail, and every refusal
 * code agree. Each refusal also proves that nothing was created: no task, no runs-index entry, and
 * no `<home>/worktrees` directory. The dry check (`host.checkRunStart`, FR2.4) must answer the same
 * codes and likewise write nothing.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import { resolveRunRequest, type RunRequest } from "../../src/durable/run-request.js";
import type { RunRecord } from "../../src/engine/index.js";
import { isArgosError } from "../../src/errors.js";
import { ModelCatalog } from "../../src/paseo/model-catalog.js";
import type { Scalar } from "../../src/playbook/ir.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { statusForCode } from "../../src/rpc/contracts.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo, writeScript, type TempRepo } from "../support/git.js";
import { drive, makeTempHome, type TempHome } from "./support.js";

const TOKEN = "parity-token-0123456789abcdef";

// ------------------------------------------------------------------ playbooks

const PARITY_PLAYBOOK = `title: Parity
inputs:
  count:
    type: number
    required: true
  flag:
    type: boolean
  mode:
    type: enum
    values:
      - fast
      - slow
  label:
    type: string
    default: hello
steps:
  - id: a
    prompt: Do the work.
`;

const TARGETED_PLAYBOOK = `title: Targeted
steps:
  - id: a
    prompt: Do the work.
    agent:
      provider: claude
      model: ghost
`;

const SCRIPTED_PLAYBOOK = `title: Scripted
steps:
  - id: build
    kind: script
    script:
      run: missing.sh
`;

const ISOLATED_PLAYBOOK = `title: Isolated
isolation: worktree
steps:
  - id: a
    prompt: Do the work.
`;

// ------------------------------------------------------------------ fixtures

interface Fixture {
  readonly clock: FakeClock;
  /** The host behind the RPC server (path a). */
  readonly serverHost: ArgosHost;
  /** The host the test drives directly (path b). */
  readonly host: ArgosHost;
  readonly server: RpcServer;
  readonly base: string;
  readonly serverHome: TempHome;
  readonly home: TempHome;
}

const fixtures: Fixture[] = [];
const repositories: TempRepo[] = [];
const directories: string[] = [];

/**
 * Two hosts on one fake clock: one behind a real RPC server, one called directly. Each host has its
 * own storage, home, and executor (request ids include the run id, so a shared executor would let
 * the two runs adopt each other's agents).
 */
async function makeFixture(options: { readonly modelCatalog?: ModelCatalog } = {}): Promise<Fixture> {
  const clock = new FakeClock();
  const serverHome = makeTempHome();
  const home = makeTempHome();
  const serverHost = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: serverHome.home,
    executor: new FakeExecutor({ completeAfterPolls: 1 }),
    clock,
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor: new FakeExecutor({ completeAfterPolls: 1 }),
    clock,
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  const server = await createRpcServer({
    host: serverHost,
    home: serverHome.home,
    port: 0,
    token: TOKEN,
  });
  const fixture: Fixture = {
    clock,
    serverHost,
    host,
    server,
    base: server.url,
    serverHome,
    home,
  };
  fixtures.push(fixture);
  return fixture;
}

/** A plain directory (not a git repository) with `.argos/playbooks/<id>.yaml`. */
function makeRepo(playbooks: Readonly<Record<string, string>>): string {
  const repo = mkdtempSync(join(tmpdir(), "argos-parity-"));
  directories.push(repo);
  for (const [id, yaml] of Object.entries(playbooks)) writePlaybook(repo, id, yaml);
  return repo;
}

function writePlaybook(repo: string, id: string, yaml: string): void {
  const dir = join(repo, ".argos", "playbooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yaml`), yaml, "utf8");
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    await fixture.server.close();
    await fixture.serverHost.close();
    await fixture.host.close();
    fixture.serverHome.cleanup();
    fixture.home.cleanup();
  }
  while (repositories.length > 0) repositories.pop()?.cleanup();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ HTTP helpers

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
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
    text,
  };
}

function errorCodeOf(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
}

// ------------------------------------------------------------------ record helpers

async function recordOf(host: ArgosHost, runId: string): Promise<RunRecord> {
  const doc = await host.getRun(runId);
  if (doc === undefined) throw new Error(`run ${runId} is not mirrored`);
  return doc.record;
}

/** The `detail` of every `run_started` history event, in order. */
async function startedDetails(host: ArgosHost, runId: string): Promise<Array<string | null>> {
  const history = await host.getHistory(runId);
  return (history?.events ?? [])
    .filter((event) => event.type === "run_started")
    .map((event) => event.detail);
}

async function statusOf(host: ArgosHost, runId: string): Promise<string | undefined> {
  return (await host.getRun(runId))?.record.status;
}

function codeOf(error: unknown): string {
  return isArgosError(error) ? error.code : `<not an ArgosError: ${String(error)}>`;
}

/** Run one async call and return the thrown error instead of propagating it. */
async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

// ------------------------------------------------------------------ parity assertions

/** FR4.1: both paths produce the same run, receipt, and history. */
describe("one start path (FR4.1)", () => {
  it("starts the same run through POST /runs and resolveRunRequest + host.startRun", async () => {
    const fixture = await makeFixture();
    const repo = makeRepo({ parity: PARITY_PLAYBOOK });
    const inputs: Record<string, Scalar> = { count: "7", flag: "true", mode: "fast" };
    const body = { playbookId: "parity", cwd: repo, inputs, clientRequestId: "parity-1" };

    // (a) the route.
    const rpc = await call(fixture.base, "POST", "/runs", body);
    expect(rpc.status, rpc.text).toBe(201);
    const receipt = rpc.body as { runId: string; taskId: string };
    expect(receipt.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The same clientRequestId replays the same receipt and starts no second run.
    const replayedOverHttp = await call(fixture.base, "POST", "/runs", body);
    expect(replayedOverHttp.status, replayedOverHttp.text).toBe(201);
    expect(replayedOverHttp.body).toEqual(receipt);
    expect(await fixture.serverHost.listRuns()).toHaveLength(1);

    // (b) the shared resolve, then the host directly — same instant, same run id, same key.
    const resolved = resolveRunRequest({ playbookId: "parity", cwd: repo, inputs });
    const direct = await fixture.host.startRun({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
      id: receipt.runId,
      clientRequestId: "parity-1",
    });
    expect(direct.runId).toBe(receipt.runId);
    expect(direct.taskId).toMatch(/^[0-9]+$/);
    expect(await fixture.host.listRuns()).toHaveLength(1);

    // A replay through the host hands back exactly the receipt it issued.
    const replayedOverHost = await fixture.host.startRun({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
      id: receipt.runId,
      clientRequestId: "parity-1",
    });
    expect(replayedOverHost).toEqual(direct);

    // Both runs progress identically on the one fake clock.
    await drive(
      fixture.clock,
      async () =>
        (await statusOf(fixture.serverHost, receipt.runId)) === "completed" &&
        (await statusOf(fixture.host, receipt.runId)) === "completed",
      { stepMs: 1_000, maxRounds: 40 },
    );

    const fromRoute = await recordOf(fixture.serverHost, receipt.runId);
    const fromHost = await recordOf(fixture.host, receipt.runId);
    expect(fromRoute.inputs).toEqual({ count: 7, flag: true, mode: "fast", label: "hello" });
    expect(fromHost).toEqual(fromRoute);

    // Equal `run_started` details: both name the playbook, and neither carries a trigger.
    expect(await startedDetails(fixture.host, receipt.runId)).toEqual(
      await startedDetails(fixture.serverHost, receipt.runId),
    );
    expect(await startedDetails(fixture.host, receipt.runId)).toEqual(["parity"]);
    expect(fromHost.trigger).toBeUndefined();
  });

  it("passes the schedule trigger through the same prepare/commit pair", async () => {
    // Phase 5's fire path: the port's prepare/commit pair is what `startRun` itself uses, so a
    // triggered run keeps the identical record shape plus `trigger`.
    const fixture = await makeFixture();
    const repo = makeRepo({ parity: PARITY_PLAYBOOK });
    const resolved = resolveRunRequest({
      playbookId: "parity",
      cwd: repo,
      inputs: { count: 1 },
    });
    const trigger = {
      kind: "schedule" as const,
      scheduleId: "nightly",
      fireAt: fixture.clock.now() - 60_000,
      reason: "cron" as const,
    };

    const outcome = await fixture.host.startPort.prepare({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
      id: "run-triggered-1",
      trigger,
    });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const root = await fixture.host.startPort.root();
    const receipt = await fixture.host.harness.commit(
      (tx) =>
        fixture.host.startPort.commitInTx(tx, outcome.prepared, root, {
          historyDetail: `parity (schedule nightly)`,
        }),
      fixture.host.context,
    );
    fixture.host.startPort.resume();

    expect(receipt.runId).toBe("run-triggered-1");
    const record = await recordOf(fixture.host, receipt.runId);
    expect(record.trigger).toEqual(trigger);
    expect(await startedDetails(fixture.host, receipt.runId)).toEqual([
      "parity (schedule nightly)",
    ]);
  });
});

// ------------------------------------------------------------------ refusals

/**
 * Run one request through both paths and assert the same refusal code, then that nothing exists.
 *
 * A refusal that happens in the resolve half (bad `cwd`, bad input) is compared directly; a refusal
 * that happens in the prepare half (missing script, unknown model, dirty base) is additionally sent
 * through `checkRunStart`, the FR2.4 dry check.
 */
async function assertRefused(
  fixture: Fixture,
  options: { readonly label: string; readonly request: RunRequest; readonly expected: string },
): Promise<void> {
  const { label, request, expected } = options;
  const body = {
    playbookId: request.playbookId,
    cwd: request.cwd,
    ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
  };

  // (a) the route.
  const rpc = await call(fixture.base, "POST", "/runs", body);
  expect(errorCodeOf(rpc.body), `${label} (route): ${rpc.text}`).toBe(expected);
  expect(rpc.status, `${label} (route status)`).toBe(statusForCode(expected));

  // (b) the shared resolve, then the host.
  let resolved: ReturnType<typeof resolveRunRequest> | undefined;
  let resolveError: unknown;
  try {
    resolved = resolveRunRequest(request);
  } catch (error) {
    resolveError = error;
  }

  let directCode: string;
  if (resolved === undefined) {
    // Resolve-level refusal: the host was never called, so nothing could be created.
    directCode = codeOf(resolveError);
  } else {
    const target = resolved;
    directCode = codeOf(
      await errorOf(() =>
        fixture.host.startRun({ ir: target.ir, inputs: target.inputs, cwd: target.cwd }),
      ),
    );
    expect(directCode, `${label} (host)`).toBe(expected);

    // The dry check (FR2.4) answers the same code for a prepare-half refusal, and writes nothing.
    const dryCode = codeOf(
      await errorOf(() =>
        fixture.host.checkRunStart({ ir: target.ir, inputs: target.inputs, cwd: target.cwd }),
      ),
    );
    expect(dryCode, `${label} (dry check)`).toBe(expected);
  }
  expect(directCode, `${label} (resolve)`).toBe(expected);

  await assertNothingCreated(fixture, label);
}

/** No task, no runs-index entry, no worktree directory, no run — on either host. */
async function assertNothingCreated(fixture: Fixture, label: string): Promise<void> {
  const hosts = [
    ["route", fixture.serverHost, fixture.serverHome.home],
    ["direct", fixture.host, fixture.home.home],
  ] as const;
  for (const [name, host, home] of hosts) {
    expect((await host.inspect()).tasks, `${label}: ${name} tasks`).toHaveLength(0);
    expect(await host.listRuns(), `${label}: ${name} runs`).toHaveLength(0);
    expect(existsSync(join(home, "worktrees")), `${label}: ${name} worktrees`).toBe(false);
  }
  const list = await call(fixture.base, "GET", "/runs");
  expect((list.body as { runs: unknown[] }).runs, `${label}: GET /runs`).toHaveLength(0);
}

describe("refusals are identical on both paths (FR4.1, FR2.4)", () => {
  it("refuses a bad cwd with invalid_request", async () => {
    const fixture = await makeFixture();
    await assertRefused(fixture, {
      label: "bad cwd",
      request: { playbookId: "parity", cwd: "relative/repo" },
      expected: "invalid_request",
    });
  });

  it("refuses a bad input with invalid_request", async () => {
    const fixture = await makeFixture();
    const repo = makeRepo({ parity: PARITY_PLAYBOOK });
    await assertRefused(fixture, {
      label: "bad input",
      request: { playbookId: "parity", cwd: repo, inputs: { count: "not-a-number" } },
      expected: "invalid_request",
    });
  });

  it("refuses a missing script with playbook_invalid", async () => {
    const fixture = await makeFixture();
    const repo = makeRepo({ scripted: SCRIPTED_PLAYBOOK });
    // A script that exists proves the pinning itself is fine; this run names a missing one.
    await assertRefused(fixture, {
      label: "missing script",
      request: { playbookId: "scripted", cwd: repo },
      expected: "playbook_invalid",
    });

    // Control: with the script in place the exact same request starts a run.
    writeScript(repo, "missing.sh", "#!/bin/sh\nexit 0\n");
    const resolved = resolveRunRequest({ playbookId: "scripted", cwd: repo });
    const started = await fixture.host.startRun({
      ir: resolved.ir,
      inputs: resolved.inputs,
      cwd: resolved.cwd,
    });
    expect(started.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("refuses an off-catalog target with model_unavailable", async () => {
    const catalog = ModelCatalog.fromSnapshot({
      providers: [
        { provider: "claude", enabled: true, models: [{ provider: "claude", id: "opus" }] },
      ],
    });
    const fixture = await makeFixture({ modelCatalog: catalog });
    const repo = makeRepo({ targeted: TARGETED_PLAYBOOK });
    await assertRefused(fixture, {
      label: "model_unavailable",
      request: { playbookId: "targeted", cwd: repo },
      expected: "model_unavailable",
    });
  });

  it("refuses a dirty base with worktree_base_dirty", async () => {
    const fixture = await makeFixture();
    const repo = makeTempRepo();
    repositories.push(repo);
    writePlaybook(repo.repo, "isolated", ISOLATED_PLAYBOOK);
    repo.git(["add", "-A"]);
    repo.git(["commit", "--quiet", "-m", "playbook isolated"]);
    // Dirty the checkout *after* the commit: a worktree cut from origin/main would miss it.
    writeFileSync(join(repo.repo, "uncommitted.txt"), "not committed\n", "utf8");

    await assertRefused(fixture, {
      label: "worktree_base_dirty",
      request: { playbookId: "isolated", cwd: repo.repo },
      expected: "worktree_base_dirty",
    });
  });

  it("creates nothing for a successful dry check (FR2.4)", async () => {
    const fixture = await makeFixture();
    const repo = makeRepo({ parity: PARITY_PLAYBOOK });
    const resolved = resolveRunRequest({ playbookId: "parity", cwd: repo, inputs: { count: 2 } });

    await expect(
      fixture.host.checkRunStart({
        ir: resolved.ir,
        inputs: resolved.inputs,
        cwd: resolved.cwd,
      }),
    ).resolves.toBeUndefined();

    await assertNothingCreated(fixture, "dry check");
  });

  it("refuses a scripted worktree run without a home from both the dry and the real check", async () => {
    // `worktree_failed` also comes from the same dry path: isolation needs `<home>/worktrees`.
    const repo = makeTempRepo();
    repositories.push(repo);
    writePlaybook(repo.repo, "isolated", ISOLATED_PLAYBOOK);
    repo.git(["add", "-A"]);
    repo.git(["commit", "--quiet", "-m", "playbook isolated"]);

    const host = await ArgosHost.open({
      storage: new MemoryStorage(),
      clock: new FakeClock(),
      executor: new FakeExecutor(),
    });
    try {
      const resolved = resolveRunRequest({ playbookId: "isolated", cwd: repo.repo });
      const input = { ir: resolved.ir, inputs: resolved.inputs, cwd: resolved.cwd };
      expect(codeOf(await errorOf(() => host.checkRunStart(input)))).toBe("worktree_failed");
      expect(codeOf(await errorOf(() => host.startRun(input)))).toBe("worktree_failed");
      expect((await host.inspect()).tasks).toHaveLength(0);
      expect(await host.listRuns()).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});
