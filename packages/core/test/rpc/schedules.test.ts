/**
 * Phase 8 verification (FR10.1, Security NFR): the schedule RPC routes and the client methods.
 *
 * The setup mirrors `test/rpc/server.test.ts`: a real in-process server, a real `ArgosHost` over
 * `MemoryStorage`, the `FakeExecutor`, and a real temporary directory carrying one playbook. Nothing
 * here sleeps on a timer; `waitForReal` is used only where a run has to settle in the background.
 *
 * The security half of the phase is asserted here too: every route is behind the bearer token, every
 * body is strict, and a schedule summary never publishes `uid`, `runIds`, `fires`, or an input whose
 * name looks like a credential.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type { FireEntry, ScheduleDoc } from "../../src/durable/schedule-docs.js";
import {
  ScheduleCreateRequestSchema,
  ScheduleDetailSchema,
  ScheduleEditRequestSchema,
  ScheduleListResponseSchema,
  ScheduleRemoveResponseSchema,
  ScheduleSummarySchema,
  type ScheduleDetail,
  type ScheduleSummary,
} from "../../src/rpc/contracts.js";
import { createRpcClient } from "../../src/rpc/client.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { toScheduleDetail } from "../../src/rpc/summary.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempHome, waitForReal, type TempHome } from "../durable/support.js";

const TOKEN = "schedule-token-0123456789abcdef";

/**
 * A step that never completes on its own: the agent stays `running`, so a run started by
 * `POST /schedules/:id/run` is still live when the same schedule is run again (FR5.2/FR7.6).
 */
const LIVE_PLAYBOOK = `title: Scheduled
steps:
  - id: a
    prompt: Work.
    poll_ms: 60000
    timeout: 6h
`;

interface Harness {
  host: ArgosHost;
  server: RpcServer;
  base: string;
  home: TempHome;
  executor: FakeExecutor;
  /** A plain temporary directory holding `.argos/playbooks/scheduled.yaml`. */
  repo: string;
}

const openHarnesses: Harness[] = [];
const repos: TempHome[] = [];

/** A directory with one playbook the schedule can resolve, and no git (isolation stays `none`). */
function makeRepo(): string {
  const directory = makeTempHome();
  repos.push(directory);
  const playbookDir = join(directory.home, ".argos", "playbooks");
  mkdirSync(playbookDir, { recursive: true });
  writeFileSync(join(playbookDir, "scheduled.yaml"), LIVE_PLAYBOOK, "utf8");
  return directory.home;
}

async function startHarness(): Promise<Harness> {
  const home = makeTempHome();
  const executor = new FakeExecutor();
  const host = await ArgosHost.open({ storage: new MemoryStorage(), home: home.home, executor });
  const server = await createRpcServer({ host, home: home.home, port: 0, token: TOKEN });
  const harness: Harness = { host, server, base: server.url, home, executor, repo: makeRepo() };
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
  while (repos.length > 0) repos.pop()?.cleanup();
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

/** The create body every test starts from: one playbook, one cron, UTC. */
function createBody(repo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playbook: "scheduled",
    cwd: repo,
    cron: "0 * * * *",
    tz: "UTC",
    ...overrides,
  };
}

async function createSchedule(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<ScheduleDetail> {
  const response = await call(harness.base, "POST", "/schedules", {
    body: createBody(harness.repo, overrides),
  });
  expect(response.status, response.text).toBe(201);
  return ScheduleDetailSchema.parse(response.body);
}

// ------------------------------------------------------------------ tests

describe("schedule RPC auth (FR10.1, Security NFR)", () => {
  it("answers 401 on every schedule route without a token", async () => {
    const harness = await startHarness();
    const routes: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/schedules"],
      ["POST", "/schedules"],
      ["GET", "/schedules/nightly"],
      ["POST", "/schedules/nightly"],
      ["DELETE", "/schedules/nightly"],
      ["POST", "/schedules/nightly/pause"],
      ["POST", "/schedules/nightly/resume"],
      ["POST", "/schedules/nightly/run"],
    ];
    for (const [method, path] of routes) {
      const missing = await fetch(`${harness.base}${path}`, { method });
      expect(missing.status, `${method} ${path}`).toBe(401);
      expect(errorCode(await missing.json()), `${method} ${path}`).toBe("unauthorized");

      const wrong = await fetch(`${harness.base}${path}`, {
        method,
        headers: auth("definitely-not-the-token"),
      });
      expect(wrong.status, `${method} ${path} (wrong token)`).toBe(401);
      expect(errorCode(await wrong.json()), `${method} ${path} (wrong token)`).toBe("unauthorized");
    }
  });
});

describe("schedule request validation (FR10.1)", () => {
  it("rejects an unknown body key, a missing cwd, and an empty edit with 400", async () => {
    const harness = await startHarness();

    const unknownCreateKey = await call(harness.base, "POST", "/schedules", {
      body: { ...createBody(harness.repo), nope: true },
    });
    expect(unknownCreateKey.status).toBe(400);
    expect(errorCode(unknownCreateKey.body)).toBe("invalid_request");

    // FR2.5: `cwd` is required — a schedule is unattended execution, never a default.
    const { cwd: _omit, ...withoutCwd } = createBody(harness.repo);
    const missingCwd = await call(harness.base, "POST", "/schedules", { body: withoutCwd });
    expect(missingCwd.status).toBe(400);
    expect(errorCode(missingCwd.body)).toBe("invalid_request");

    await createSchedule(harness, { id: "nightly" });

    // FR7.2: an edit that changes nothing is refused instead of bumping `generation` silently.
    const emptyEdit = await call(harness.base, "POST", "/schedules/nightly", { body: {} });
    expect(emptyEdit.status).toBe(400);
    expect(errorCode(emptyEdit.body)).toBe("invalid_request");

    const unknownEditKey = await call(harness.base, "POST", "/schedules/nightly", {
      body: { cron: "30 * * * *", playbook: "other" },
    });
    expect(unknownEditKey.status).toBe(400);
    expect(errorCode(unknownEditKey.body)).toBe("invalid_request");

    const badCatchUp = await call(harness.base, "POST", "/schedules/nightly", {
      body: { catchUp: "1w" },
    });
    expect(badCatchUp.status).toBe(400);
    expect(errorCode(badCatchUp.body)).toBe("invalid_request");

    // The host is the single gate for the id alphabet, so a bad id is the same code as any edit.
    const badId = await call(harness.base, "POST", "/schedules", {
      body: createBody(harness.repo, { id: "Not An Id" }),
    });
    expect(badId.status).toBe(400);
    expect(errorCode(badId.body)).toBe("invalid_request");
  });

  it("answers 405 for a read-only method on a known path and 404 for an unknown one", async () => {
    const harness = await startHarness();
    await createSchedule(harness, { id: "nightly" });

    const put = await call(harness.base, "PUT", "/schedules/nightly");
    expect(put.status).toBe(405);
    expect(errorCode(put.body)).toBe("method_not_allowed");

    const getPause = await call(harness.base, "GET", "/schedules/nightly/pause");
    expect(getPause.status).toBe(405);
    expect(errorCode(getPause.body)).toBe("method_not_allowed");

    const deleteAll = await call(harness.base, "DELETE", "/schedules");
    expect(deleteAll.status).toBe(405);
    expect(errorCode(deleteAll.body)).toBe("method_not_allowed");

    const unknownAction = await call(harness.base, "POST", "/schedules/nightly/explode");
    expect(unknownAction.status).toBe(404);
    expect(errorCode(unknownAction.body)).toBe("not_found");

    const tooDeep = await call(harness.base, "GET", "/schedules/nightly/pause/extra");
    expect(tooDeep.status).toBe(404);
    expect(errorCode(tooDeep.body)).toBe("not_found");
  });
});

describe("schedule read model (FR10.1)", () => {
  it("creates, lists by id, edits, pauses, and resumes with the contract schemas", async () => {
    const harness = await startHarness();

    // Created out of order on purpose: the list must come back sorted by id, not by creation.
    const beta = await createSchedule(harness, { id: "beta" });
    const alpha = await createSchedule(harness, { id: "alpha" });
    for (const created of [beta, alpha]) {
      expect(ScheduleDetailSchema.safeParse(created).success).toBe(true);
      expect(created.playbookId).toBe("scheduled");
      expect(created.cwd).toBe(harness.repo);
      expect(created.overlap).toBe("skip");
      expect(created.catchUp).toBe("all");
      expect(created.keep).toBe(30);
      expect(created.enabled).toBe(true);
      expect(created.generation).toBe(0);
      expect(created.consecutiveFailures).toBe(0);
      expect(typeof created.nextFireAt).toBe("number");
    }

    const list = await call(harness.base, "GET", "/schedules");
    expect(list.status).toBe(200);
    const parsed = ScheduleListResponseSchema.parse(list.body);
    expect(parsed.schedules.map((schedule) => schedule.id)).toEqual(["alpha", "beta"]);

    const detail = await call(harness.base, "GET", "/schedules/beta");
    expect(detail.status).toBe(200);
    expect(ScheduleDetailSchema.parse(detail.body).id).toBe("beta");

    const edited = await call(harness.base, "POST", "/schedules/beta", {
      body: { cron: "30 * * * *", overlap: "allow", keep: "all", catchUp: "90m" },
    });
    expect(edited.status).toBe(200);
    const editedDetail = ScheduleDetailSchema.parse(edited.body);
    expect(editedDetail.cron).toBe("30 * * * *");
    expect(editedDetail.overlap).toBe("allow");
    expect(editedDetail.keep).toBe("all");
    expect(editedDetail.catchUp).toBe(5_400_000);
    expect(editedDetail.generation).toBe(1);

    const paused = await call(harness.base, "POST", "/schedules/beta/pause");
    expect(paused.status).toBe(200);
    const pausedSummary: ScheduleSummary = ScheduleSummarySchema.parse(paused.body);
    expect(pausedSummary.enabled).toBe(false);
    expect(pausedSummary.nextFireAt).toBeNull();

    const resumed = await call(harness.base, "POST", "/schedules/beta/resume");
    expect(resumed.status).toBe(200);
    const resumedSummary = ScheduleSummarySchema.parse(resumed.body);
    expect(resumedSummary.enabled).toBe(true);
    expect(typeof resumedSummary.nextFireAt).toBe("number");

    const removed = await call(harness.base, "DELETE", "/schedules/alpha");
    expect(removed.status).toBe(200);
    expect(ScheduleRemoveResponseSchema.parse(removed.body)).toEqual({
      id: "alpha",
      removed: true,
    });
    const afterRemove = await call(harness.base, "GET", "/schedules");
    expect(
      ScheduleListResponseSchema.parse(afterRemove.body).schedules.map((schedule) => schedule.id),
    ).toEqual(["beta"]);
  });

  it("never publishes uid, runIds, fires, or a secret-looking input", async () => {
    const harness = await startHarness();
    const created = await createSchedule(harness, {
      id: "nightly",
      inputs: { issue: "42", API_TOKEN: "s3cret-value" },
    });

    const response = await call(harness.base, "GET", "/schedules/nightly");
    expect(response.status).toBe(200);
    const listed = ScheduleListResponseSchema.parse(
      (await call(harness.base, "GET", "/schedules")).body,
    );
    const summary = listed.schedules[0];
    if (summary === undefined) throw new Error("the schedule list lost nightly");
    expect(summary.id).toBe("nightly");
    expect(response.text).not.toContain("s3cret-value");
    expect(summary.inputs).toEqual({ issue: "42" });
    expect(summary).not.toHaveProperty("uid");
    expect(summary).not.toHaveProperty("runIds");
    expect(summary).not.toHaveProperty("fires");
    // The document itself still stores both inputs (only the projection filters).
    const stored = await harness.host.getSchedule("nightly");
    expect(stored?.inputs).toEqual({ issue: "42", API_TOKEN: "s3cret-value" });
    expect(created.inputs).toEqual({ issue: "42" });
  });

  it("publishes the fire log and at most ten recent run ids", async () => {
    const harness = await startHarness();
    await createSchedule(harness, { id: "nightly" });

    // No run yet: the detail carries both fields, empty.
    const fresh = ScheduleDetailSchema.parse(
      (await call(harness.base, "GET", "/schedules/nightly")).body,
    );
    expect(fresh.fires).toEqual([]);
    expect(fresh.recentRunIds).toEqual([]);

    const started = await call(harness.base, "POST", "/schedules/nightly/run");
    expect(started.status, started.text).toBe(201);
    const { runId } = started.body as { runId: string; taskId: string };

    let detail: ScheduleDetail = fresh;
    await waitForReal(async () => {
      const response = await call(harness.base, "GET", "/schedules/nightly");
      detail = ScheduleDetailSchema.parse(response.body);
      return detail.recentRunIds.includes(runId);
    });
    expect(detail.recentRunIds.slice(0, 1)).toEqual([runId]);
    expect(detail.fires[0]).toEqual(
      expect.objectContaining({ status: "started", reason: "run_now", runId }),
    );
    expect(detail.liveRunId).toBe(runId);
  });

  it("caps recentRunIds at ten while keeping the rest of the stored list out of the wire", () => {
    // FR10.1: the cap is a projection rule, so it is checked directly rather than by firing 11 runs.
    const runIds = Array.from({ length: 12 }, (_unused, index) => `run-${String(index + 1)}`);
    const fire: FireEntry = {
      fireAt: 1_767_225_600_000,
      at: 1_767_225_600_500,
      reason: "cron",
      status: "refused",
      errorCode: "paseo_unreachable",
      message: "the Paseo daemon is unreachable",
    };
    const doc: ScheduleDoc = {
      id: "nightly",
      uid: "01J9ZZZZZZZZZZZZZZZZZZZZZZ",
      playbookId: "scheduled",
      cwd: "/tmp/repo",
      inputs: { issue: "42", GITHUB_TOKEN: "hidden" },
      cron: "0 * * * *",
      tz: "UTC",
      overlap: "skip",
      catchUp: "all",
      keep: 30,
      enabled: true,
      generation: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      nextFireAt: 1_767_229_200_000,
      lastFire: fire,
      liveRunId: "run-12",
      runIds,
      fires: [fire],
      consecutiveFailures: 1,
    };

    const detail = ScheduleDetailSchema.parse(toScheduleDetail(doc));
    expect(detail.recentRunIds).toHaveLength(10);
    expect(detail.recentRunIds).toEqual(runIds.slice(0, 10));
    expect(detail.fires).toHaveLength(1);
    expect(detail.fires[0]?.count).toBeUndefined();
    expect(detail.lastFire).toEqual({
      fireAt: fire.fireAt,
      at: fire.at,
      reason: "cron",
      status: "refused",
      errorCode: "paseo_unreachable",
      message: "the Paseo daemon is unreachable",
    });
    // The same filter a run summary applies (Security NFR).
    expect(detail.inputs).toEqual({ issue: "42" });
    expect(detail).not.toHaveProperty("uid");
    expect(detail).not.toHaveProperty("runIds");
  });
});

describe("schedule error codes (FR10.1)", () => {
  it("maps schedule_unknown to 404 and schedule_exists to 409", async () => {
    const harness = await startHarness();
    await createSchedule(harness, { id: "nightly" });

    for (const [method, path] of [
      ["GET", "/schedules/missing"],
      ["POST", "/schedules/missing"],
      ["POST", "/schedules/missing/pause"],
      ["POST", "/schedules/missing/resume"],
      ["POST", "/schedules/missing/run"],
      ["DELETE", "/schedules/missing"],
    ] as ReadonlyArray<readonly [string, string]>) {
      const response = await call(harness.base, method, path, {
        ...(method === "POST" && path === "/schedules/missing" ? { body: { cron: "0 * * * *" } } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(errorCode(response.body), `${method} ${path}`).toBe("schedule_unknown");
    }

    const duplicate = await call(harness.base, "POST", "/schedules", {
      body: createBody(harness.repo, { id: "nightly" }),
    });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe("schedule_exists");
  });

  it("refuses a second run now while the first is live (run_active, 409)", async () => {
    const harness = await startHarness();
    await createSchedule(harness, { id: "nightly" });

    // No body at all: an empty POST is a plain run now (the client may send `{}` or nothing).
    const first = await call(harness.base, "POST", "/schedules/nightly/run");
    expect(first.status, first.text).toBe(201);
    const { runId } = first.body as { runId: string };

    // The run document is durable before the response, so it is already live; wait for the run task
    // to reach `running` so the assertion below cannot race the first tick.
    await waitForReal(async () => {
      const detail = await call(harness.base, "GET", `/runs/${runId}`);
      return detail.status === 200 && (detail.body as { status: string }).status === "running";
    });

    // FR5.2/FR7.6: `overlap: skip` (the default) refuses rather than starting a second run.
    const second = await call(harness.base, "POST", "/schedules/nightly/run");
    expect(second.status).toBe(409);
    expect(errorCode(second.body)).toBe("run_active");
    expect(second.text).toContain(runId);
  });
});

describe("RpcClient schedule methods (FR10.1)", () => {
  it("drives create → list → get → edit → pause → resume → run → remove", async () => {
    const harness = await startHarness();
    const client = createRpcClient({
      home: harness.home.home,
      url: harness.base,
      token: TOKEN,
    });

    const created = await client.createSchedule({
      id: "nightly",
      playbook: "scheduled",
      cwd: harness.repo,
      cron: "0 * * * *",
      tz: "UTC",
      inputs: { issue: "7" },
      // FR5.2: `allow` keeps the run now below from colliding with the live run; the second call is
      // stopped earlier by the D15 receipt, not by the overlap rule.
      overlap: "allow",
    });
    expect(ScheduleDetailSchema.parse(created).id).toBe("nightly");
    expect(created.inputs).toEqual({ issue: "7" });

    const listed = await client.listSchedules();
    expect(listed.schedules.map((schedule) => schedule.id)).toEqual(["nightly"]);

    const shown = await client.getSchedule("nightly");
    expect(shown.cron).toBe("0 * * * *");
    expect(shown.tz).toBe("UTC");

    const edited = await client.editSchedule("nightly", { cron: "15 3 * * *", tz: "Europe/Oslo" });
    expect(edited.cron).toBe("15 3 * * *");
    expect(edited.tz).toBe("Europe/Oslo");
    expect(edited.generation).toBe(1);

    const paused = await client.pauseSchedule("nightly");
    expect(paused.enabled).toBe(false);
    expect(paused.nextFireAt).toBeNull();

    const resumed = await client.resumeSchedule("nightly");
    expect(resumed.enabled).toBe(true);
    expect(typeof resumed.nextFireAt).toBe("number");

    const started = await client.runSchedule("nightly", { clientRequestId: "run-once" });
    expect(started.runId).not.toBe("");
    expect(started.taskId).not.toBe("");
    // D15: the same request id returns the same receipt instead of a second run.
    const replayed = await client.runSchedule("nightly", { clientRequestId: "run-once" });
    expect(replayed).toEqual(started);

    const removed = await client.removeSchedule("nightly");
    expect(removed).toEqual({ id: "nightly", removed: true });

    const gone = await client.getSchedule("nightly").catch((error: unknown) => error);
    expect((gone as { code?: string }).code).toBe("schedule_unknown");
    expect((gone as { status?: number }).status).toBe(404);

    // The run list still works: `/runs` behavior is untouched by the schedule block.
    const runs = await client.listRuns();
    expect(runs.runs.map((run) => run.id)).toEqual([started.runId]);
  });
});

describe("schedule contract schemas (FR10.1)", () => {
  it("rejects an empty edit and any unknown key, and accepts the CLI's catch-up shorthand", () => {
    expect(ScheduleEditRequestSchema.safeParse({}).success).toBe(false);
    expect(ScheduleEditRequestSchema.safeParse({ keep: 5 }).success).toBe(true);
    expect(ScheduleCreateRequestSchema.safeParse({ playbook: "p", cwd: "/tmp" }).success).toBe(
      false,
    );
    expect(
      ScheduleCreateRequestSchema.safeParse({
        playbook: "p",
        cwd: "/tmp",
        cron: "0 * * * *",
        catchUp: "90m",
        keep: "all",
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      ScheduleCreateRequestSchema.safeParse({
        playbook: "p",
        cwd: "/tmp",
        cron: "0 * * * *",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
