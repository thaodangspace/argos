/**
 * Phase 6 verification: fire failure (FR6.1–FR6.5), run now (FR7.6, FR3.9), and fire events (FR10.4).
 *
 * Everything is deterministic: a `FakeClock` at a fixed epoch, the `FakeExecutor`, a real temporary
 * repository with a local bare origin, and `host.scheduleIdle()` as the seam that waits for the tick
 * behind a fire. No test sleeps and no test reads the wall clock.
 *
 * The three properties this file exists for:
 *
 * - **A refusal is durable and harmless (G5).** A fire whose prepare half fails writes one
 *   document-only commit (`refused` + `consecutiveFailures + 1` + the next fire time), creates no
 *   run and no task, and leaves the schedule enabled — and the code it records is the code the same
 *   broken values answer on `POST /runs`.
 * - **Run now is the same fire (FR7.6).** It serializes behind an in-flight the fire (FR3.9), never
 *   changes `nextFireAt`, works on a paused schedule, and refuses with `run_active` — writing
 *   nothing — while `overlap: skip` holds a live run.
 * - **One event per written entry (FR10.4),** never for an aborted write, and never a value.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import type { ScheduleFireEvent, ScheduleFireListener } from "../../src/durable/host-types.js";
import {
  ScheduleDocFamily,
  registerSchedule,
  scheduleRunId,
  writeScheduleDoc,
  type ScheduleDoc,
} from "../../src/durable/schedule-docs.js";
import { ScheduleRunner } from "../../src/durable/schedules.js";
import { isArgosError } from "../../src/errors.js";
import type { GitRunner } from "../../src/git/exec.js";
import { execFileGit } from "../../src/git/exec.js";
import type { TargetCatalog } from "../../src/paseo/model-catalog.js";
import type { Scalar } from "../../src/playbook/ir.js";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.js";
import { FakeClock, flushMicrotasks } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo, writeScript, type TempRepo } from "../support/git.js";
import { drive, makeTempHome, type TempHome } from "./support.js";

// ------------------------------------------------------------------ fixtures

/** A step that never completes on its own, so a run stays live for every gap a test crosses. */
const LIVE = `title: Live
steps:
  - id: a
    prompt: Work.
    poll_ms: 60000
    timeout: 6h
`;

/** A number input, so an edit of the *playbook* can make the stored value fail coercion. */
const COUNTED = `title: Counted
inputs:
  count:
    type: number
steps:
  - id: a
    prompt: Work.
`;

/** The same playbook after a deploy renamed the input type: `3` is no longer a valid value. */
const COUNTED_ENUM = `title: Counted
inputs:
  count:
    type: enum
    values:
      - fast
      - slow
steps:
  - id: a
    prompt: Work.
`;

/** One step, no inputs: the prompt is the only thing an operator edits between two fires. */
const EDITABLE = `title: Editable
steps:
  - id: a
    prompt: "Fire one."
`;

/** `EDITABLE` after the operator rewrote the prompt; nothing else about the playbook changed. */
const EDITED = `title: Editable
steps:
  - id: a
    prompt: "Fire two."
`;

const SCRIPTED = `title: Scripted
steps:
  - id: build
    kind: script
    script:
      run: build.sh
`;

const ISOLATED = `title: Isolated
isolation: worktree
steps:
  - id: a
    prompt: Work.
`;

const TARGETED = `title: Targeted
steps:
  - id: a
    prompt: Work.
    agent:
      provider: claude
      model: ghost
`;

/** FR6.2: a value that is only ever supplied as an input, so it may never reach a stored message. */
const SENTINEL = "SENTINEL-XYZ";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The fixed epoch of the suite: 2026-06-01 (a Monday) in UTC, with no DST in play. */
function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 5, 1, hour, minute);
}

interface World {
  readonly clock: FakeClock;
  readonly home: TempHome;
  readonly repo: TempRepo;
  readonly executor: FakeExecutor;
  /** Replaced by `reopen` on a sqlite world; every other test reads it once. */
  host: ArgosHost;
  /** `true` stores in a temporary `$ARGOS_HOME`, so the test can close and reopen the host. */
  readonly sqlite: boolean;
  /** Present only for the `POST /runs` parity cases. */
  readonly server?: RpcServer;
}

const hosts: ArgosHost[] = [];
const servers: RpcServer[] = [];
const homes: TempHome[] = [];
const repositories: TempRepo[] = [];
const runners: ScheduleRunner[] = [];

function writePlaybook(repo: string, id: string, yaml: string): void {
  const directory = join(repo, ".argos", "playbooks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.yaml`), yaml, "utf8");
}

/** A clean checkout with the given playbooks committed (a worktree base must be clean). */
function makeRepo(playbooks: Readonly<Record<string, string>>): TempRepo {
  const repo = makeTempRepo();
  repositories.push(repo);
  for (const [id, yaml] of Object.entries(playbooks)) writePlaybook(repo.repo, id, yaml);
  repo.git(["add", "-A"]);
  repo.git(["commit", "--quiet", "-m", "playbooks"]);
  return repo;
}

const TOKEN = "schedule-fire-token-0123456789abcdef";

async function makeWorld(
  options: {
    readonly at?: number;
    readonly playbooks?: Readonly<Record<string, string>>;
    readonly git?: GitRunner;
    readonly modelCatalog?: TargetCatalog;
    readonly rpc?: boolean;
    readonly sqlite?: boolean;
  } = {},
): Promise<World> {
  const repo = makeRepo(options.playbooks ?? { nightly: LIVE });
  const home = makeTempHome();
  homes.push(home);
  const clock = new FakeClock(options.at ?? at(6, 59));
  const executor = new FakeExecutor();
  const sqlite = options.sqlite === true;
  const host = await ArgosHost.open({
    ...(sqlite ? {} : { storage: new MemoryStorage() }),
    home: home.home,
    executor,
    clock,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  hosts.push(host);
  const world: World = { clock, home, repo, executor, host, sqlite };
  if (options.rpc !== true) return world;
  const server = await createRpcServer({ host, home: home.home, port: 0, token: TOKEN });
  servers.push(server);
  return { ...world, server };
}

/** Reopen a sqlite world's host on the same home and clock: the process-restart seam (G4). */
async function reopen(world: World): Promise<void> {
  if (!world.sqlite) throw new Error("reopen needs a sqlite world");
  world.host = await ArgosHost.open({
    home: world.home.home,
    clock: world.clock,
    executor: new FakeExecutor(),
  });
  hosts.push(world.host);
}

afterEach(async () => {
  while (runners.length > 0) await runners.pop()?.close();
  while (servers.length > 0) await servers.pop()?.close();
  while (hosts.length > 0) await hosts.pop()?.close();
  while (homes.length > 0) homes.pop()?.cleanup();
  while (repositories.length > 0) repositories.pop()?.cleanup();
});

// ------------------------------------------------------------------ helpers

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

interface HeldGit {
  readonly runner: GitRunner;
  readonly fetchStarted: Promise<void>;
  release(): void;
}

/**
 * A git port that holds exactly one `git fetch` (the worktree base fetch a fire performs) on a
 * deferred, and delegates everything else to the real `execFileGit`. This is how a test keeps a fire
 * *inside* prepare, between the decision and the commit (FR3.9, FR4.5).
 */
function holdFetch(): HeldGit {
  const gate = deferred();
  const started = deferred();
  let armed = true;
  return {
    fetchStarted: started.promise,
    release: () => gate.resolve(),
    runner: async (invocation) => {
      if (armed && invocation.args[0] === "fetch") {
        armed = false;
        started.resolve();
        await gate.promise;
      }
      return execFileGit(invocation);
    },
  };
}

async function addSchedule(
  world: World,
  input: {
    readonly id?: string;
    readonly playbookId?: string;
    readonly cron?: string;
    readonly inputs?: Readonly<Record<string, Scalar>>;
    readonly overlap?: "skip" | "allow";
    readonly isolation?: "none" | "worktree";
    readonly enabled?: boolean;
  } = {},
): Promise<ScheduleDoc> {
  return world.host.addSchedule({
    ...(input.id === undefined ? {} : { id: input.id }),
    playbookId: input.playbookId ?? "nightly",
    cwd: world.repo.repo,
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    cron: input.cron ?? "0 * * * *",
    tz: "UTC",
    ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
    ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  });
}

async function schedule(world: World, id: string): Promise<ScheduleDoc> {
  const doc = await world.host.getSchedule(id);
  if (doc === undefined) throw new Error(`schedule ${id} is gone`);
  return doc;
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

function removePlaybook(world: World, id: string): void {
  rmSync(join(world.repo.repo, ".argos", "playbooks", `${id}.yaml`));
}

/** FR10.4: a listener that just records into `into` (which a restart can share), for ordering. */
function collect(
  world: World,
  into: ScheduleFireEvent[] = [],
): { readonly events: ScheduleFireEvent[]; detach: () => void } {
  const listener: ScheduleFireListener = (event) => {
    into.push(event);
  };
  return { events: into, detach: world.host.observeScheduleFires(listener) };
}

// ------------------------------------------------------------------ refused fires (FR6)

describe("a refused fire (FR6.1–FR6.5)", () => {
  it("records the refusal, keeps the schedule, and does not retry before the next fire time", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly", inputs: { note: SENTINEL } });
    await world.host.scheduleIdle();
    // The operator (or a deploy) removes the playbook after the schedule was added. The add-time dry
    // check passed, so only the fire can notice (FR4.2).
    removePlaybook(world, "nightly");

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    const doc = await schedule(world, "hourly");
    expect(doc.enabled).toBe(true);
    expect(doc.lastFire).toMatchObject({
      fireAt: at(7),
      at: at(7),
      reason: "cron",
      status: "refused",
      errorCode: "playbook_missing",
    });
    // The outcome is the log head; the schedule moves on instead of retrying this instant.
    expect(doc.fires[0]).toEqual(doc.lastFire);
    expect(doc.fires).toHaveLength(1);
    expect(doc.consecutiveFailures).toBe(1);
    expect(doc.nextFireAt).toBe(at(8));

    // FR6.1/FR6.2: no run, no task, and a bounded message that carries no input value.
    expect(await world.host.listRuns()).toEqual([]);
    expect((await world.host.inspect()).tasks).toHaveLength(0);
    const message = doc.lastFire?.message ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(doc.lastFire)).not.toContain(SENTINEL);
    expect(JSON.stringify(doc.fires)).not.toContain(SENTINEL);
    // The sentinel appears in the document exactly once: in the operator's stored input map, which
    // the schedule keeps by design (Security NFR "inputs are stored in SQLite"). Nothing the refusal
    // wrote adds a second occurrence — not the message, not a detail, not a field name.
    const serialised = JSON.stringify(doc);
    expect(serialised).toContain(SENTINEL);
    expect(serialised.indexOf(SENTINEL)).toBe(serialised.lastIndexOf(SENTINEL));

    // FR6.3: no retry before the next fire time.
    await world.clock.advance(59 * MINUTE);
    await world.host.scheduleIdle();
    expect((await schedule(world, "hourly")).fires).toHaveLength(1);
    expect(await world.host.listRuns()).toEqual([]);

    // FR6.1/FR6.5: the next fire time fails too, the streak grows, and the schedule stays enabled.
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    const second = await schedule(world, "hourly");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.fires.map((entry) => entry.status)).toEqual(["refused", "refused"]);
    expect(second.nextFireAt).toBe(at(9));
    expect(second.enabled).toBe(true);
    expect(await world.host.listRuns()).toEqual([]);
  });

  it("writes the missed summary under the refused outcome, like a started fire does", async () => {
    const world = await makeWorld({ sqlite: true });
    await addSchedule(world, { id: "hourly" });
    await world.host.scheduleIdle();
    removePlaybook(world, "nightly");

    // Three hours down: the tick that resumes at 10:00 sees 07:00–09:00 as earlier due fire times and
    // 10:00 as the one to fire, which is then refused (FR3.4, FR3.6, FR6.1).
    await world.host.close();
    await world.clock.advanceTo(at(10));
    await reopen(world);
    const { events } = collect(world);
    await world.host.scheduleIdle();

    const doc = await schedule(world, "hourly");
    expect(doc.fires.map((entry) => entry.status)).toEqual(["refused", "missed"]);
    expect(doc.fires[1]).toMatchObject({
      count: 3,
      from: at(7),
      to: at(9),
      status: "missed",
    });
    expect(doc.lastFire).toMatchObject({ status: "refused", fireAt: at(10) });
    expect(doc.nextFireAt).toBe(at(11));
    expect(doc.consecutiveFailures).toBe(1);
    // One event per written entry, in log order (missed covers the earlier instants).
    expect(events.map((event) => event.status)).toEqual(["missed", "refused"]);
    expect(events[0]?.count).toBe(3);
    expect(events[1]?.errorCode).toBe("playbook_missing");
    expect(await world.host.listRuns()).toEqual([]);
  });

  it("stores a null code and only the error name for a failure that is not an ArgosError", async () => {
    const world = await makeWorld();
    const now = world.clock.now();
    // A schedule document written straight into storage: this test drives its own runner, so the
    // host's runner never sees it and the add-time dry check is not in the way.
    const doc: ScheduleDoc = {
      id: "fail",
      uid: "schedule-fail-uid",
      playbookId: "nightly",
      cwd: world.repo.repo,
      inputs: {},
      cron: "0 * * * *",
      tz: "UTC",
      overlap: "skip",
      catchUp: "all",
      keep: 30,
      enabled: true,
      generation: 0,
      createdAt: now,
      updatedAt: now,
      nextFireAt: at(7),
      runIds: [],
      fires: [],
      consecutiveFailures: 0,
    };
    await world.host.harness.commit(async (tx) => {
      await writeScheduleDoc(tx, doc);
      await registerSchedule(tx, doc.id);
    }, world.host.context);

    // FR6.2: an unexpected failure must not be able to store its message (which could embed a value),
    // so only its `name` is kept — the port is the honest seam for a non-ArgosError.
    const runner = new ScheduleRunner({
      harness: world.host.harness,
      context: world.host.context,
      clock: world.clock,
      home: world.home.home,
      port: {
        ...world.host.startPort,
        prepare: async () => {
          throw new Error(`unexpected ${SENTINEL}`);
        },
      },
    });
    runners.push(runner);
    await runner.start();
    await world.clock.advance(MINUTE);
    await runner.idle();
    await runner.close();

    const stored = await schedule(world, "fail");
    expect(stored.lastFire).toMatchObject({ status: "refused", message: "Error" });
    expect(stored.consecutiveFailures).toBe(1);
    expect(stored.nextFireAt).toBe(at(8));
    expect(JSON.stringify(stored.lastFire)).not.toContain(SENTINEL);
    // FR6.2 says the code is `null` for a non-ArgosError. The stored value keeps that placeholder
    // (the typed read model drops every `null`, like `runId`), so the assertion reads storage.
    const raw = await world.host.harness.snapshot(ScheduleDocFamily, "fail", world.host.context);
    expect(raw?.lastFire).toMatchObject({ status: "refused", errorCode: null, message: "Error" });
    expect(await world.host.listRuns()).toEqual([]);
  });
});

// ------------------------------------------------------------------ parity with POST /runs

interface RefusalCase {
  readonly label: string;
  readonly playbooks: Readonly<Record<string, string>>;
  readonly playbookId: string;
  readonly inputs?: Readonly<Record<string, Scalar>>;
  readonly isolation?: "none" | "worktree";
  readonly modelCatalog?: TargetCatalog;
  /** Runs before the schedule is added (a script the add-time dry check must find). */
  readonly prepare?: (world: World) => void;
  /** Breaks the environment after the add, so only the fire (and `POST /runs`) can notice. */
  readonly breakIt: (world: World) => void;
  readonly expected: string;
}

/** `POST /runs` → the stable error code, or `<status>` when the route unexpectedly accepted. */
async function routeCode(world: World, body: unknown): Promise<string> {
  if (world.server === undefined) throw new Error("this world has no RPC server");
  const response = await fetch(`${world.server.url}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.trim() === "" ? undefined : (JSON.parse(text) as unknown);
  const code = (parsed as { error?: { code?: string } } | undefined)?.error?.code;
  return code ?? `<http ${response.status}>`;
}

/**
 * FR2.4/FR4.1: the same broken values must answer the same code on `POST /runs` and on a fire.
 *
 * The route answers first (a refusal writes nothing), then the fire is due and its `lastFire` is read
 * back, so both see exactly the same broken checkout in the same instant.
 */
async function assertRefusalParity(options: RefusalCase): Promise<void> {
  const world = await makeWorld({
    playbooks: options.playbooks,
    rpc: true,
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  options.prepare?.(world);
  await addSchedule(world, {
    id: "case",
    playbookId: options.playbookId,
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
  });
  await world.host.scheduleIdle();
  options.breakIt(world);

  const route = await routeCode(world, {
    playbookId: options.playbookId,
    cwd: world.repo.repo,
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
  });
  expect(route, `${options.label}: POST /runs`).toBe(options.expected);

  await world.clock.advance(MINUTE);
  await world.host.scheduleIdle();

  const doc = await schedule(world, "case");
  expect(doc.lastFire?.status, `${options.label}: status`).toBe("refused");
  expect(doc.lastFire?.errorCode, `${options.label}: fire code`).toBe(options.expected);
  expect(await world.host.listRuns(), `${options.label}: runs`).toEqual([]);
}

describe("a refused fire answers the same code as POST /runs (FR2.4, FR4.1, FR6.2)", () => {
  it("refuses a deleted playbook with playbook_missing", async () => {
    await assertRefusalParity({
      label: "playbook_missing",
      playbooks: { nightly: LIVE },
      playbookId: "nightly",
      breakIt: (world) => {
        removePlaybook(world, "nightly");
      },
      expected: "playbook_missing",
    });
  });

  it("refuses a deleted script with playbook_invalid", async () => {
    await assertRefusalParity({
      label: "playbook_invalid",
      playbooks: { scripted: SCRIPTED },
      playbookId: "scripted",
      prepare: (world) => {
        writeScript(world.repo.repo, "build.sh", "#!/bin/sh\nexit 0\n");
      },
      breakIt: (world) => {
        rmSync(join(world.repo.repo, ".argos", "scripts", "build.sh"));
      },
      expected: "playbook_invalid",
    });
  });

  it("refuses a stored input the playbook no longer accepts with invalid_request", async () => {
    await assertRefusalParity({
      label: "invalid_request",
      playbooks: { counted: COUNTED },
      playbookId: "counted",
      inputs: { count: 3 },
      breakIt: (world) => {
        // A deploy renamed the input type; the schedule still stores `3`.
        writePlaybook(world.repo.repo, "counted", COUNTED_ENUM);
      },
      expected: "invalid_request",
    });
  });

  it("refuses a dirty base with worktree_base_dirty", async () => {
    await assertRefusalParity({
      label: "worktree_base_dirty",
      playbooks: { isolated: ISOLATED },
      playbookId: "isolated",
      isolation: "worktree",
      breakIt: (world) => {
        writeFileSync(join(world.repo.repo, "uncommitted.txt"), "not committed\n", "utf8");
      },
      expected: "worktree_base_dirty",
    });
  });

  it("refuses an off-catalog target with model_unavailable", async () => {
    // A mutable stub: the add-time dry check passes, then the catalog loses the model.
    let available = true;
    const catalog: TargetCatalog = {
      missingTargets: (ir) => (available ? [] : [`${ir.id}: claude/ghost`]),
    };
    await assertRefusalParity({
      label: "model_unavailable",
      playbooks: { targeted: TARGETED },
      playbookId: "targeted",
      modelCatalog: catalog,
      breakIt: () => {
        available = false;
      },
      expected: "model_unavailable",
    });
  });
});

// ------------------------------------------------------------------ fire-time reload (FR4.2)

describe("a fire reloads the playbook (FR4.2)", () => {
  it("gives the edit to the next fire's run and never to the run that already started", async () => {
    const world = await makeWorld({ playbooks: { nightly: EDITABLE } });
    await addSchedule(world, { id: "hourly" });
    await world.host.scheduleIdle();

    // Fire one at 07:00, against the playbook as it is on disk.
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    const firstFire = (await schedule(world, "hourly")).lastFire;
    expect(firstFire).toMatchObject({ fireAt: at(7), status: "started" });
    const firstRunId = String(firstFire?.runId);
    const firstRun = (await world.host.getRun(firstRunId))?.record;
    expect(firstRun?.ir.steps[0]?.prompt).toBe("Fire one.");

    // Let the fired run finish, so `overlap: skip` (the default) allows the next fire.
    world.executor.completeAll();
    await drive(
      world.clock,
      async () => (await world.host.getRun(firstRunId))?.record.status === "completed",
      { stepMs: MINUTE, maxRounds: 5 },
    );

    // A deploy edits the prompt between two fires. The schedule document is not touched.
    writePlaybook(world.repo.repo, "nightly", EDITED);
    await world.clock.advance(HOUR);
    await world.host.scheduleIdle();

    // Fire two loads the file again: a new run id, a new hash, and the new prompt on disk.
    const secondFire = (await schedule(world, "hourly")).lastFire;
    expect(secondFire).toMatchObject({ fireAt: at(8), status: "started" });
    const secondRunId = String(secondFire?.runId);
    expect(secondRunId).not.toBe(firstRunId);
    const secondRun = (await world.host.getRun(secondRunId))?.record;
    expect(secondRun?.ir.steps[0]?.prompt).toBe("Fire two.");
    expect(secondRun?.playbookHash).not.toBe(firstRun?.playbookHash);
    expect(world.executor.latestAgentForStep("a")?.prompt).toBe("Fire two.");

    // The first run is unaffected evidence: it keeps the definition it started with.
    expect((await world.host.getRun(firstRunId))?.record.ir.steps[0]?.prompt).toBe("Fire one.");
  });
});

// ------------------------------------------------------------------ run now (FR7.6, FR3.9)

describe("run now (FR7.6)", () => {
  it("fires a paused schedule at once, with reason run_now, and leaves nextFireAt alone", async () => {
    const world = await makeWorld();
    const added = await addSchedule(world, { id: "nightly", enabled: false });
    await world.host.scheduleIdle();
    expect(added.nextFireAt).toBeNull();

    const receipt = await world.host.runSchedule("nightly");
    expect(receipt.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(receipt.taskId).toMatch(/^[0-9]+$/);
    // FR4.3: run now uses a fresh id, never the fire time's deterministic one.
    expect(receipt.runId).not.toBe(scheduleRunId(added.uid, world.clock.now()));

    const run = await world.host.getRun(receipt.runId);
    expect(run?.record.trigger).toEqual({
      kind: "schedule",
      scheduleId: "nightly",
      fireAt: at(6, 59),
      reason: "run_now",
    });
    const history = await world.host.getHistory(receipt.runId);
    expect(history?.events[0]).toMatchObject({
      type: "run_started",
      detail: "nightly (schedule nightly)",
    });

    const doc = await schedule(world, "nightly");
    // FR7.6: the pause and its missing next fire time are untouched by run now.
    expect(doc.enabled).toBe(false);
    expect(doc.nextFireAt).toBeNull();
    expect(doc.lastFire).toMatchObject({
      fireAt: at(6, 59),
      reason: "run_now",
      status: "started",
      runId: receipt.runId,
    });
    expect(doc.runIds).toEqual([receipt.runId]);
    expect(doc.liveRunId).toBe(receipt.runId);
    expect(doc.consecutiveFailures).toBe(0);
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("refuses with run_active — writing nothing — while a skip schedule holds a live run", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly" });
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    const liveRunId = (await world.host.listRuns())[0]?.record.id;
    expect(liveRunId).toBeDefined();
    const before = await schedule(world, "hourly");

    const error = await errorOf(() => world.host.runSchedule("hourly"));
    expect(codeOf(error)).toBe("run_active");
    // FR7.6: the message names the run that holds the schedule.
    expect((error as Error).message).toContain(String(liveRunId));

    // Nothing was written: the fire log, the streak, `lastFire`, and `updatedAt` are all untouched.
    const after = await schedule(world, "hourly");
    expect(after.fires).toEqual(before.fires);
    expect(after.lastFire).toEqual(before.lastFire);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("records a refusal, grows the streak, keeps nextFireAt, and rethrows", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly" });
    await world.host.scheduleIdle();
    const before = await schedule(world, "hourly");
    expect(before.nextFireAt).toBe(at(7));
    removePlaybook(world, "nightly");

    const error = await errorOf(() => world.host.runSchedule("hourly"));
    expect(codeOf(error)).toBe("playbook_missing");

    const after = await schedule(world, "hourly");
    // FR7.6: the refusal is recorded, the timing is not.
    expect(after.nextFireAt).toBe(before.nextFireAt);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastFire).toMatchObject({
      fireAt: at(6, 59),
      reason: "run_now",
      status: "refused",
      errorCode: "playbook_missing",
    });
    expect(after.fires.map((entry) => entry.status)).toEqual(["refused"]);
    expect(await world.host.listRuns()).toEqual([]);
  });

  it("returns the same receipt for a replayed clientRequestId and writes nothing new", async () => {
    const world = await makeWorld();
    // `allow` keeps the pre-check out of the way: the replay has to reach prepare's D15 fast path.
    await addSchedule(world, { id: "hourly", overlap: "allow" });
    await world.host.scheduleIdle();

    const first = await world.host.runSchedule("hourly", { clientRequestId: "run-now-1" });
    const afterFirst = await schedule(world, "hourly");
    const replayed = await world.host.runSchedule("hourly", { clientRequestId: "run-now-1" });

    expect(replayed).toEqual(first);
    const afterReplay = await schedule(world, "hourly");
    expect(afterReplay.fires).toEqual(afterFirst.fires);
    expect(afterReplay.lastFire).toEqual(afterFirst.lastFire);
    expect(afterReplay.updatedAt).toBe(afterFirst.updatedAt);
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("waits for a fire that is in flight and then applies the overlap rule (FR3.9)", async () => {
    const held = holdFetch();
    const world = await makeWorld({ git: held.runner });
    await addSchedule(world, { id: "isolated", isolation: "worktree" });

    await world.clock.advance(MINUTE);
    await held.fetchStarted;

    // The timer fire is inside `prepare`. Run now must queue behind it on the one chain, so by the
    // time it takes its decision the fire's run exists and `overlap: skip` refuses it.
    const pending = world.host.runSchedule("isolated").then(
      () => {
        throw new Error("run now should have been refused while the fired run is live");
      },
      (error: unknown) => error,
    );
    await flushMicrotasks();
    held.release();
    await world.host.scheduleIdle();

    const error = await pending;
    const doc = await schedule(world, "isolated");
    expect(doc.lastFire?.status).toBe("started");
    expect(doc.fires.map((entry) => entry.status)).toEqual(["started"]);
    expect(codeOf(error)).toBe("run_active");
    expect((error as Error).message).toContain(String(doc.liveRunId));
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("refuses an unknown id with schedule_unknown", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly" });
    await world.host.scheduleIdle();
    const error = await errorOf(() => world.host.runSchedule("nope"));
    expect(codeOf(error)).toBe("schedule_unknown");
  });
});

// ------------------------------------------------------------------ events (FR10.4)

describe("observeScheduleFires (FR10.4)", () => {
  it("announces exactly one event per written entry, never a value, and detaches", async () => {
    const world = await makeWorld({ sqlite: true });
    await addSchedule(world, { id: "hourly", inputs: { note: SENTINEL } });
    await world.host.scheduleIdle();
    // One log for the whole test: the restart below subscribes its own runner to the same array.
    const events: ScheduleFireEvent[] = [];
    collect(world, events);

    // started
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    expect(events.map((event) => event.status)).toEqual(["started"]);
    expect(events[0]).toMatchObject({ scheduleId: "hourly", fireAt: at(7), status: "started" });
    expect(events[0]?.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // skipped_overlap: the fired run is still live an hour later.
    await world.clock.advance(HOUR);
    await world.host.scheduleIdle();
    expect(events.map((event) => event.status)).toEqual(["started", "skipped_overlap"]);
    expect(events[1]).toMatchObject({ fireAt: at(8), runId: events[0]?.runId });

    // The run finishes, so the overlap pre-check no longer applies and a fire reaches prepare again.
    world.executor.completeAll();
    const runId = String(events[0]?.runId);
    await drive(world.clock, async () => (await world.host.getRun(runId))?.record.status === "completed", {
      stepMs: MINUTE,
      maxRounds: 5,
    });

    // A `catchUp: 0` schedule, edited while the playbook still exists (an edit runs the dry check).
    await world.host.editSchedule("hourly", { catchUp: 0 });
    await world.host.scheduleIdle();
    const refusedAt = (await schedule(world, "hourly")).nextFireAt;
    expect(refusedAt).not.toBeNull();
    if (refusedAt === null) return;

    // refused: the playbook is gone when the fire is due.
    removePlaybook(world, "nightly");
    await world.clock.advanceTo(refusedAt);
    await world.host.scheduleIdle();
    expect(events.at(-1)).toMatchObject({
      fireAt: refusedAt,
      status: "refused",
      errorCode: "playbook_missing",
    });

    // missed: the host is down over the next fire time, and a `catchUp: 0` schedule never fires late.
    const missedAt = (await schedule(world, "hourly")).nextFireAt;
    expect(missedAt).not.toBeNull();
    if (missedAt === null) return;
    await world.host.close();
    await world.clock.advanceTo(missedAt + 3 * MINUTE);
    await reopen(world);
    // A new process has a new runner: the restarted one is subscribed to the same log.
    const restarted = collect(world, events);
    await world.host.scheduleIdle();
    expect(events.at(-1)).toMatchObject({ fireAt: missedAt, status: "missed", count: 1 });

    // Exactly one event per entry, in log order — and no input value anywhere in them.
    expect(events.map((event) => event.status)).toEqual([
      "started",
      "skipped_overlap",
      "refused",
      "missed",
    ]);
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(SENTINEL);
    }

    // Detaching stops delivery even though the schedule keeps writing entries.
    restarted.detach();
    const delivered = events.length;
    await world.clock.advance(3 * HOUR);
    await world.host.scheduleIdle();
    expect(events).toHaveLength(delivered);
    expect((await schedule(world, "hourly")).fires.length).toBeGreaterThan(delivered);
  });

  it("keeps running when a listener throws", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly" });
    await world.host.scheduleIdle();
    const seen: ScheduleFireEvent[] = [];
    world.host.observeScheduleFires(() => {
      throw new Error("a listener must never break the runner");
    });
    world.host.observeScheduleFires((event) => {
      seen.push(event);
    });

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    expect(seen.map((event) => event.status)).toEqual(["started"]);
    expect(await world.host.listRuns()).toHaveLength(1);
  });
});
