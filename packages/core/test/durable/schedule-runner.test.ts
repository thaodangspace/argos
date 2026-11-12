/**
 * Phase 5 verification: the runner core (FR3, FR4, FR5, G3, G4).
 *
 * Everything here is deterministic: a `FakeClock` at a fixed epoch, the `FakeExecutor`, a real
 * temporary repository with a local bare origin, and `host.scheduleIdle()` as the seam that waits
 * for a tick or a fire. No test sleeps, and no test reads the wall clock.
 *
 * The durable guarantees are what most of this file proves:
 *
 * - **G3** (one run per fire time): the fire commits the run and `lastFire` together, inside one
 *   guard-checked commit, and the run id is the fire time's ULID. The cron-fire, restart, and
 *   guard tests hold whichever half the test can hold (git `fetch`, an edit, a delete, a seeded
 *   `lastFire`) and assert that no second run appears.
 * - **G4** (one catch-up run per schedule): the catch-up tests close the host over a gap, reopen it
 *   at a later clock, and assert one run plus, at most, one `missed` entry with the right count.
 */

import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/durable/context.js";
import { ArgosHost } from "../../src/durable/host.js";
import {
  scheduleRunId,
  writeScheduleDoc,
  type ScheduleDoc,
} from "../../src/durable/schedule-docs.js";
import type { GitRunner } from "../../src/git/exec.js";
import { execFileGit } from "../../src/git/exec.js";
import { createRunWorktree } from "../../src/git/worktree.js";
import { loadPlaybook } from "../../src/playbook/index.js";
import { TIMER_MAX_MS } from "../../src/schedule/model.js";
import { FakeClock, flushMicrotasks } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo, type TempRepo } from "../support/git.js";
import { drive, makeTempHome, type TempHome } from "./support.js";

// ------------------------------------------------------------------ fixtures

/**
 * A step that never completes on its own: the agent stays `running` until the test completes it.
 * `timeout` is longer than any gap a test crosses, so a "live" run stays live (FR5.2).
 */
const LIVE = `title: Live
steps:
  - id: a
    prompt: Work.
    poll_ms: 60000
    timeout: 6h
`;

/** A live main step plus an `auto` after-task whose own step stays running (FR5.3). */
const AFTER = `title: With after
steps:
  - id: main
    prompt: Main.
    poll_ms: 60000
    timeout: 6h
after:
  - id: report
    title: Report
    trigger: auto
    steps:
      - id: report-step
        prompt: Report.
        poll_ms: 60000
        timeout: 6h
`;

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** The fixed epoch of the suite: 2026-06-01 (a Monday) in UTC, with no DST in play. */
function at(hour: number, minute = 0, day = 1): number {
  return Date.UTC(2026, 5, day, hour, minute);
}

interface World {
  readonly clock: FakeClock;
  readonly home: TempHome;
  readonly repo: TempRepo;
  readonly sqlite: boolean;
  readonly executor: FakeExecutor;
  host: ArgosHost;
}

const hosts: ArgosHost[] = [];
const homes: TempHome[] = [];
const repositories: TempRepo[] = [];

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

async function openHost(options: {
  readonly clock: Clock;
  readonly home: string;
  readonly executor: FakeExecutor;
  readonly storage?: Storage;
  readonly git?: GitRunner;
}): Promise<ArgosHost> {
  const host = await ArgosHost.open({
    home: options.home,
    clock: options.clock,
    executor: options.executor,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.git === undefined ? {} : { git: options.git }),
  });
  hosts.push(host);
  return host;
}

/**
 * One host plus its world. `sqlite: true` stores in a temporary `$ARGOS_HOME` so the test can close
 * and reopen the host (a `MemoryStorage` cannot be reopened); the default is in-memory storage.
 */
async function makeWorld(
  options: {
    readonly at?: number;
    readonly playbooks?: Readonly<Record<string, string>>;
    readonly sqlite?: boolean;
    readonly git?: GitRunner;
  } = {},
): Promise<World> {
  const repo = makeRepo(options.playbooks ?? { nightly: LIVE });
  const home = makeTempHome();
  homes.push(home);
  const clock = new FakeClock(options.at ?? at(6, 59));
  const executor = new FakeExecutor();
  const sqlite = options.sqlite === true;
  const host = await openHost({
    clock,
    home: home.home,
    executor,
    ...(sqlite ? {} : { storage: new MemoryStorage() }),
    ...(options.git === undefined ? {} : { git: options.git }),
  });
  return { clock, home, repo, sqlite, executor, host };
}

/** Reopen the world's host on the same `$ARGOS_HOME` and clock (FR3.2, G3/G4 across a restart). */
async function reopen(world: World, options: { readonly git?: GitRunner } = {}): Promise<void> {
  if (!world.sqlite) throw new Error("reopen needs a sqlite world");
  world.host = await openHost({
    clock: world.clock,
    home: world.home.home,
    executor: new FakeExecutor(),
    ...(options.git === undefined ? {} : { git: options.git }),
  });
}

afterEach(async () => {
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
  /** Resolves when a `git fetch` was reached and is now blocked. */
  readonly fetchStarted: Promise<void>;
  release(): void;
}

/**
 * A git port that holds exactly one `git fetch` (the worktree base fetch a fire performs) on a
 * deferred, and delegates everything else to the real `execFileGit`. This is how a test stops a fire
 * *inside* `prepare`, between the decision and the commit (FR4.5).
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

/** A clock that records every armed delay, so the 60 s cap can be asserted (FR3.1). */
class RecordingClock implements Clock {
  readonly delays: number[] = [];
  readonly #inner: FakeClock;

  constructor(inner: FakeClock) {
    this.#inner = inner;
  }

  now = (): number => this.#inner.now();

  setTimer = (
    callback: () => void,
    delayMs: number,
    options: { readonly background: boolean },
  ): (() => void) | undefined => {
    this.delays.push(delayMs);
    void options;
    return this.#inner.setTimer(callback, delayMs);
  };
}

/** Add the one schedule a test needs, with the defaults under test overridden per case. */
async function addSchedule(
  world: World,
  input: {
    readonly id?: string;
    readonly playbookId?: string;
    readonly cron?: string;
    readonly catchUp?: "all" | number | string;
    readonly overlap?: "skip" | "allow";
    readonly isolation?: "none" | "worktree";
    readonly enabled?: boolean;
  } = {},
): Promise<ScheduleDoc> {
  return world.host.addSchedule({
    ...(input.id === undefined ? {} : { id: input.id }),
    playbookId: input.playbookId ?? "nightly",
    cwd: world.repo.repo,
    cron: input.cron ?? "0 * * * *",
    tz: "UTC",
    ...(input.catchUp === undefined ? {} : { catchUp: input.catchUp }),
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

// ------------------------------------------------------------------ idle ticks

describe("the timer (FR3.1)", () => {
  it("writes nothing while no schedule is due", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "daily", cron: "@daily" });
    await world.host.scheduleIdle();

    let commits = 0;
    const observation = world.host.harness.observeCommits({
      advance: () => {
        commits += 1;
      },
      end: () => undefined,
    });
    await world.clock.advance(10 * MINUTE);
    await world.host.scheduleIdle();
    observation.detach();

    // A tick with nothing due reads only the in-memory cache: no snapshot, no commit (NFR).
    expect(commits).toBe(0);
    expect(await world.host.listRuns()).toEqual([]);
    expect((await schedule(world, "daily")).fires).toEqual([]);
  });

  it("arms no timer at all when no schedule is enabled", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "paused", enabled: false });
    await world.host.scheduleIdle();
    // The harness arms one housekeeping timer of its own; once that has run, the paused schedule
    // must leave nothing armed at all.
    await world.clock.advance(10 * MINUTE);
    await world.host.scheduleIdle();
    expect(world.clock.armed).toBe(0);

    // Thirty days with no timer would trip the FakeClock's timer-storm guard if anything armed one.
    await world.clock.advance(30 * DAY);
    await world.host.scheduleIdle();
    expect(world.clock.armed).toBe(0);
    expect(await world.host.listRuns()).toEqual([]);
  });

  it("never sleeps longer than TIMER_MAX_MS, even with a fire three hours away", async () => {
    const repo = makeRepo({ nightly: LIVE });
    const home = makeTempHome();
    homes.push(home);
    const fake = new FakeClock(at(6, 59));
    const clock = new RecordingClock(fake);
    const host = await openHost({
      clock,
      home: home.home,
      executor: new FakeExecutor(),
      storage: new MemoryStorage(),
    });
    // `open()` arms the harness's own housekeeping timer; only the runner's armings matter here.
    await host.scheduleIdle();
    clock.delays.length = 0;

    const added = await host.addSchedule({
      id: "morning",
      playbookId: "nightly",
      cwd: repo.repo,
      cron: "0 10 * * *",
      tz: "UTC",
    });
    expect(added.nextFireAt).toBe(at(10));
    // The armed delay is the cap, not the three hours until the fire.
    expect(clock.delays.at(-1)).toBe(TIMER_MAX_MS);

    let commits = 0;
    const observation = host.harness.observeCommits({
      advance: () => {
        commits += 1;
      },
      end: () => undefined,
    });
    clock.delays.length = 0;
    await fake.advance(MINUTE);
    await host.scheduleIdle();
    observation.detach();

    // The 60 s timer woke the runner, which found nothing due and re-armed for another 60 s.
    expect(clock.delays).toEqual([TIMER_MAX_MS]);
    expect(commits).toBe(0);
    expect(await host.listRuns()).toEqual([]);
  });
});

// ------------------------------------------------------------------ firing

describe("a due schedule fires once (FR4, G3)", () => {
  it("starts one run at the fire time, with the schedule trigger and history detail", async () => {
    const world = await makeWorld();
    const added = await addSchedule(world, { id: "hourly", cron: "0 * * * *" });
    expect(added.nextFireAt).toBe(at(7));

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    const runId = scheduleRunId(added.uid, at(7));
    const runs = await world.host.listRuns();
    expect(runs.map((doc) => doc.record.id)).toEqual([runId]);
    expect(runs[0]?.record.trigger).toEqual({
      kind: "schedule",
      scheduleId: "hourly",
      fireAt: at(7),
      reason: "cron",
    });

    const history = await world.host.getHistory(runId);
    expect(history?.events[0]).toMatchObject({
      type: "run_started",
      detail: "nightly (schedule hourly)",
    });

    const doc = await schedule(world, "hourly");
    expect(doc.lastFire).toMatchObject({
      fireAt: at(7),
      at: at(7),
      reason: "cron",
      status: "started",
      runId,
    });
    expect(doc.nextFireAt).toBe(at(8));
    expect(doc.liveRunId).toBe(runId);
    expect(doc.runIds).toEqual([runId]);
    expect(doc.consecutiveFailures).toBe(0);
    expect(doc.fires.map((entry) => entry.status)).toEqual(["started"]);

    // The fire time is settled: half an hour later there is still exactly one run.
    await world.clock.advance(30 * MINUTE);
    await world.host.scheduleIdle();
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("starts no second run when the host reopens after a fire (G3)", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 59) });
    await addSchedule(world, { id: "hourly" });
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    expect(await world.host.listRuns()).toHaveLength(1);

    await world.host.close();
    await reopen(world);
    await world.host.scheduleIdle();
    expect(await world.host.listRuns()).toHaveLength(1);

    await world.clock.advance(30 * MINUTE);
    await world.host.scheduleIdle();
    const runs = await world.host.listRuns();
    expect(runs).toHaveLength(1);
    expect((await schedule(world, "hourly")).runIds).toHaveLength(1);
  });

  it("reuses the run id's worktree instead of cutting a second one (FR4.6)", async () => {
    const world = await makeWorld();
    const added = await addSchedule(world, { id: "isolated", isolation: "worktree" });
    const runId = scheduleRunId(added.uid, at(7));
    const worktrees = join(world.home.home, "worktrees");

    // A crash before the commit leaves the worktree behind; the next fire must adopt it.
    await createRunWorktree({ repo: world.repo.repo, home: world.home.home, runId });
    expect(readdirSync(worktrees)).toEqual([runId]);

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    const record = (await world.host.getRun(runId))?.record;
    expect(record?.worktree?.path).toBe(join(worktrees, runId));
    expect(readdirSync(worktrees)).toEqual([runId]);
    // The run's agent works in the reused checkout.
    await drive(world.clock, () => world.executor.creationsByStep()["a"] === 1, {
      stepMs: MINUTE,
      maxRounds: 3,
    });
    expect(world.executor.agentForStep("a").cwd).toBe(join(worktrees, runId));
  });

  it("fires two schedules due at once in nextFireAt order (FR3.3)", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 0) });
    const hourly = await addSchedule(world, { id: "hourly", overlap: "allow" });
    const quarterHourly = await addSchedule(world, {
      id: "quarter-hourly",
      cron: "45 * * * *",
      overlap: "allow",
    });
    expect(hourly.nextFireAt).toBe(at(7));
    expect(quarterHourly.nextFireAt).toBe(at(6, 45));

    // 07:50: both are due. The quarter-hourly schedule fires 07:45 and the hourly one 07:00, so the
    // order of the runs proves the tick sorts by `nextFireAt` (06:45 before 07:00), not by fire time
    // or id.
    await world.host.close();
    await world.clock.advanceTo(at(7, 50));
    await reopen(world);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs.map((doc) => doc.record.trigger)).toMatchObject([
      { scheduleId: "quarter-hourly", fireAt: at(7, 45), reason: "catch_up" },
      { scheduleId: "hourly", fireAt: at(7), reason: "catch_up" },
    ]);
    expect(await schedule(world, "quarter-hourly")).toMatchObject({
      liveRunId: runs[0]?.record.id,
    });
    expect(await schedule(world, "hourly")).toMatchObject({ liveRunId: runs[1]?.record.id });
    // The earlier due time of the quarter-hourly schedule is counted, not silently dropped.
    const quarterDoc = await schedule(world, "quarter-hourly");
    expect(quarterDoc.fires.map((entry) => entry.status)).toEqual(["started", "missed"]);
    expect(quarterDoc.fires[1]).toMatchObject({ count: 1, from: at(6, 45), to: at(6, 45) });
  });
});

// ------------------------------------------------------------------ catch-up

describe("catch-up when the host opens (FR3.5–FR3.7, G4)", () => {
  it("fires one catch_up run for a daily schedule reopened hours late, with no missed entry", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 59) });
    await addSchedule(world, { id: "daily", cron: "0 7 * * *" });

    await world.host.close();
    await world.clock.advanceTo(at(9, 30));
    await reopen(world);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.record.trigger).toMatchObject({
      fireAt: at(7),
      reason: "catch_up",
    });
    const doc = await schedule(world, "daily");
    expect(doc.lastFire).toMatchObject({ fireAt: at(7), status: "started", reason: "catch_up" });
    expect(doc.fires.map((entry) => entry.status)).toEqual(["started"]);
    expect(doc.nextFireAt).toBe(at(7, 0, 2));
  });

  it("summarises three days of hourly fire times in one missed entry", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 0) });
    await addSchedule(world, { id: "hourly" });

    await world.host.close();
    await world.clock.advanceTo(at(6, 5, 4));
    await reopen(world);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.record.trigger).toMatchObject({ fireAt: at(6, 0, 4), reason: "catch_up" });

    const doc = await schedule(world, "hourly");
    const missed = doc.fires.filter((entry) => entry.status === "missed");
    expect(missed).toHaveLength(1);
    // 72 due fire times: the last one runs and the 71 earlier ones are the missed range.
    expect(missed[0]).toMatchObject({
      fireAt: at(6, 0, 4),
      reason: "catch_up",
      count: 71,
      from: at(7, 0, 1),
      to: at(5, 0, 4),
    });
    expect(doc.fires[0]?.status).toBe("started");
  });

  it("refuses to fire outside a 30m catch-up window and records the fire time as missed", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 59) });
    await addSchedule(world, { id: "daily", cron: "0 7 * * *", catchUp: "30m" });

    await world.host.close();
    await world.clock.advanceTo(at(7, 45));
    await reopen(world);
    await world.host.scheduleIdle();

    expect(await world.host.listRuns()).toEqual([]);
    const doc = await schedule(world, "daily");
    expect(doc.lastFire).toMatchObject({ status: "missed", fireAt: at(7), reason: "catch_up" });
    expect(doc.fires).toHaveLength(1);
    // The missed entry names the fire time it skipped as its last instant.
    expect(doc.fires[0]).toMatchObject({
      status: "missed",
      fireAt: at(7),
      count: 1,
      from: at(7),
      to: at(7),
    });
    expect(doc.nextFireAt).toBe(at(7, 0, 2));
  });

  it("fires 90 s late under catchUp 0 and misses a fire three minutes late", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 59) });
    await addSchedule(world, { id: "daily", cron: "0 7 * * *", catchUp: 0 });

    // 90 s late: still inside the two-minute grace, so it is a plain `cron` fire.
    await world.host.close();
    await world.clock.advanceTo(at(7, 1) + 30_000);
    await reopen(world);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.record.trigger).toMatchObject({ fireAt: at(7), reason: "cron" });
    expect((await schedule(world, "daily")).fires.map((entry) => entry.status)).toEqual(["started"]);
  });

  it("misses under catchUp 0 once the grace is over", async () => {
    const world = await makeWorld({ sqlite: true, at: at(6, 59) });
    await addSchedule(world, { id: "daily", cron: "0 7 * * *", catchUp: 0 });

    await world.host.close();
    await world.clock.advanceTo(at(7, 3));
    await reopen(world);
    await world.host.scheduleIdle();

    expect(await world.host.listRuns()).toEqual([]);
    const doc = await schedule(world, "daily");
    expect(doc.fires[0]).toMatchObject({ status: "missed", fireAt: at(7), count: 1, to: at(7) });
  });

  it("counts a per-minute backlog past the limit as 10000+", async () => {
    const world = await makeWorld({ sqlite: true, at: at(0, 0) });
    await addSchedule(world, { id: "every-minute", cron: "* * * * *" });

    await world.host.close();
    // 00:05:30 on day 9: the last due minute is 00:05, five and a half minutes late.
    await world.clock.advance(8 * DAY + 5 * MINUTE + 30_000);
    await reopen(world);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs).toHaveLength(1);
    // A per-minute expression is always within the two-minute tolerance, so it is a `cron` fire.
    expect(runs[0]?.record.trigger).toMatchObject({ fireAt: at(0, 5, 9), reason: "cron" });

    const doc = await schedule(world, "every-minute");
    const missed = doc.fires.find((entry) => entry.status === "missed");
    expect(missed?.count).toBe("10000+");
    expect(missed?.fireAt).toBe(at(0, 5, 9));
    expect(missed?.to).toBe(at(0, 5, 9) - MINUTE);
    expect(doc.lastFire?.status).toBe("started");
  });
});

// ------------------------------------------------------------------ commit guards

describe("the fire commit guards (FR4.5, G3)", () => {
  it("aborts the fire when the schedule was edited while prepare ran, keeping the edit", async () => {
    const held = holdFetch();
    const world = await makeWorld({ git: held.runner });
    await addSchedule(world, { id: "isolated", isolation: "worktree" });

    await world.clock.advance(MINUTE);
    await held.fetchStarted;
    // The fire is now held inside prepare (git fetch), before its single commit.
    await world.host.editSchedule("isolated", { keep: 2 });
    held.release();
    await world.host.scheduleIdle();

    expect(await world.host.listRuns()).toEqual([]);
    const doc = await schedule(world, "isolated");
    expect(doc.keep).toBe(2);
    expect(doc.generation).toBe(1);
    expect(doc.lastFire).toBeUndefined();
  });

  it("aborts the fire when the schedule was deleted while prepare ran", async () => {
    const held = holdFetch();
    const world = await makeWorld({ git: held.runner });
    await addSchedule(world, { id: "isolated", isolation: "worktree" });

    await world.clock.advance(MINUTE);
    await held.fetchStarted;
    await world.host.removeSchedule("isolated");
    held.release();
    await world.host.scheduleIdle();

    expect(await world.host.listRuns()).toEqual([]);
    expect(await world.host.getSchedule("isolated")).toBeUndefined();
    expect(await world.host.listSchedules()).toEqual([]);
  });

  it("adopts a run that already exists for the fire time instead of starting a second one (G3)", async () => {
    const world = await makeWorld();
    const added = await addSchedule(world, { id: "hourly" });
    const runId = scheduleRunId(added.uid, at(7));
    // A run carrying the exact id the fire will use: the state a crash after a previous commit
    // leaves behind, or an operator start that picked the deterministic id.
    await world.host.startRun({
      ir: loadPlaybook(world.repo.repo, "nightly"),
      inputs: {},
      cwd: world.repo.repo,
      id: runId,
    });

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();

    const runs = await world.host.listRuns();
    expect(runs.map((doc) => doc.record.id)).toEqual([runId]);
    const doc = await schedule(world, "hourly");
    expect(doc.lastFire).toMatchObject({ status: "started", fireAt: at(7), runId });
    expect(doc.nextFireAt).toBe(at(8));

    // The adopted instant is settled: the tick neither retries it nor starts another run.
    await world.clock.advance(30 * MINUTE);
    await world.host.scheduleIdle();
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("records a missed entry instead of a run when the fire time already landed", async () => {
    const held = holdFetch();
    const world = await makeWorld({ git: held.runner });
    await addSchedule(world, { id: "isolated", isolation: "worktree" });

    await world.clock.advance(MINUTE);
    await held.fetchStarted;
    // Someone else (a crash recovery, or a clock that moved back) already recorded this fire time.
    const before = await schedule(world, "isolated");
    await world.host.harness.commit(
      (tx) =>
        writeScheduleDoc(tx, {
          ...before,
          lastFire: {
            fireAt: before.nextFireAt ?? at(7),
            at: world.clock.now(),
            reason: "cron",
            status: "started",
            runId: "run-already-landed",
          },
        }),
      world.host.context,
    );

    held.release();
    await world.host.scheduleIdle();
    expect(await world.host.listRuns()).toEqual([]);

    // The next tick sees `lastFire >= L` and advances by recording the fire time as missed.
    await world.clock.advance(TIMER_MAX_MS);
    await world.host.scheduleIdle();
    const doc = await schedule(world, "isolated");
    expect(doc.fires[0]).toMatchObject({ status: "missed", fireAt: at(7), count: 1, to: at(7) });
    expect(doc.nextFireAt).toBe(at(8));
    expect(await world.host.listRuns()).toEqual([]);
  });
});

// ------------------------------------------------------------------ overlap

describe("overlap (FR5)", () => {
  it("skips the fire while the previous run is live, writing no prepare I/O", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly" });

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    const firstRun = (await world.host.listRuns())[0]?.record.id;
    expect(firstRun).toBeDefined();
    expect(world.executor.launchCalls).toHaveLength(1);

    // The run is still live at 08:00: the fire is skipped, not queued.
    await world.clock.advance(HOUR);
    await world.host.scheduleIdle();

    expect(await world.host.listRuns()).toHaveLength(1);
    // No prepare I/O at all: the skip never resolved the playbook or launched an agent.
    expect(world.executor.launchCalls).toHaveLength(1);
    const doc = await schedule(world, "hourly");
    expect(doc.lastFire).toMatchObject({
      fireAt: at(8),
      status: "skipped_overlap",
      runId: firstRun,
    });
    expect(doc.nextFireAt).toBe(at(9));
    expect(doc.liveRunId).toBe(firstRun);
    expect(doc.runIds).toEqual([firstRun]);
    expect(doc.fires.map((entry) => entry.status)).toEqual(["skipped_overlap", "started"]);

    // FR5.3: a removed run counts as not live, so the next hour fires again.
    world.executor.completeAll();
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    expect((await world.host.getRun(String(firstRun)))?.record.status).toBe("completed");
    await world.host.removeRun(String(firstRun));

    await world.clock.advance(59 * MINUTE);
    await world.host.scheduleIdle();

    const after = await schedule(world, "hourly");
    expect(after.lastFire?.status).toBe("started");
    expect(after.runIds).toHaveLength(2);
    expect(after.runIds[0]).toBe(after.lastFire?.runId);
    expect(await world.host.listRuns()).toHaveLength(1);
  });

  it("treats a terminal parent with a running after-task as not live (FR5.3)", async () => {
    const world = await makeWorld({ playbooks: { after: AFTER } });
    await addSchedule(world, { id: "hourly", playbookId: "after" });

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    const parentId = (await world.host.listRuns())[0]?.record.id;
    expect(parentId).toBeDefined();

    world.executor.completeAll();
    await drive(
      world.clock,
      async () => {
        const record = (await world.host.getRun(String(parentId)))?.record;
        const after = Object.values(record?.after ?? {})[0];
        return record?.status === "completed" && after?.status === "running";
      },
      { stepMs: MINUTE, maxRounds: 5 },
    );
    expect(await world.host.getRun(String(parentId)).then((doc) => doc?.record.status)).toBe(
      "completed",
    );

    // The parent is terminal, so the live after-task does not hold the next fire back.
    await world.clock.advanceTo(at(8));
    await world.host.scheduleIdle();
    const doc = await schedule(world, "hourly");
    expect(doc.lastFire?.status).toBe("started");
    expect(doc.runIds).toHaveLength(2);
    expect(doc.liveRunId).not.toBe(parentId);
  });

  it("allow starts a second run and keeps the newest run live (FR5.4)", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "hourly", overlap: "allow" });

    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    const firstRun = (await world.host.listRuns())[0]?.record.id;

    await world.clock.advance(HOUR);
    await world.host.scheduleIdle();

    const doc = await schedule(world, "hourly");
    expect(doc.lastFire?.status).toBe("started");
    expect(doc.runIds).toHaveLength(2);
    expect(doc.liveRunId).toBe(doc.runIds[0]);
    expect(doc.liveRunId).not.toBe(firstRun);
    expect(await world.host.listRuns()).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ shutdown

describe("close (FR3.2)", () => {
  it("waits for a fire held in prepare and leaves no runner timer behind", async () => {
    const held = holdFetch();
    const world = await makeWorld({ git: held.runner });
    await addSchedule(world, { id: "isolated", isolation: "worktree" });

    await world.clock.advance(MINUTE);
    await held.fetchStarted;

    let closed = false;
    const closing = world.host.close().then(() => {
      closed = true;
    });
    await flushMicrotasks();
    // The fire is still inside prepare, so close has not returned.
    expect(closed).toBe(false);

    held.release();
    await closing;
    expect(closed).toBe(true);
    // The runner disarmed its timer, and the closed harness cancelled its own.
    expect(world.clock.armed).toBe(0);
  });
});

// ------------------------------------------------------------------ sanity

describe("fixture hygiene", () => {
  it("creates no worktrees directory for a run that does not need one", async () => {
    const world = await makeWorld();
    await addSchedule(world, { id: "plain" });
    await world.clock.advance(MINUTE);
    await world.host.scheduleIdle();
    expect(existsSync(join(world.home.home, "worktrees"))).toBe(false);
  });
});
