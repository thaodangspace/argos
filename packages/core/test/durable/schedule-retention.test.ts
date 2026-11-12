/**
 * Phase 7 verification: retention (FR9.1–FR9.3, G7).
 *
 * Everything is deterministic: a `FakeClock` at a fixed epoch, the `FakeExecutor` (configured to
 * finish a step on its first poll, so a fired run completes without moving time), a real temporary
 * repository with a local bare origin, and `host.scheduleIdle()` as the seam that waits for the tick
 * behind a fire — including the prune that follows it.
 *
 * The properties this file exists for:
 *
 * - **Retention is bounded (FR9.1/FR9.2).** `runIds` is newest first, so a fire that leaves more than
 *   `keep` ids behind prunes everything past the newest `keep` — and `keep: "all"` prunes nothing.
 * - **Retention is harmless (FR9.3).** It runs after the fire's commit and outside it, it never
 *   removes a worktree or a branch, it keeps a live run, a broken `removeRun` changes nothing, and an
 *   id the cap already dropped is out of its reach — so a fire's outcome is decided before pruning
 *   starts and can never be changed by it.
 */

import { MemoryStorage } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArgosHost } from "../../src/durable/host.js";
import type { ScheduleFireEvent } from "../../src/durable/host-types.js";
import { RunsIndexDoc } from "../../src/durable/mirror.js";
import {
  registerSchedule,
  writeScheduleDoc,
  type ScheduleDoc,
} from "../../src/durable/schedule-docs.js";
import { ScheduleRunner } from "../../src/durable/schedules.js";
import { isTerminalRunStatus } from "../../src/engine/index.js";
import { KEEP_DEFAULT, RUN_IDS_LIMIT } from "../../src/schedule/model.js";
import { FakeClock } from "../fakes/clock.js";
import { FakeExecutor } from "../fakes/executor.js";
import { makeTempRepo, type TempRepo } from "../support/git.js";
import { drive, makeTempHome, type TempHome } from "./support.js";

// ------------------------------------------------------------------ fixtures

/** One step; `poll_ms` is long because a completing world finishes it on the first poll anyway. */
const ONE_STEP = `title: One
steps:
  - id: a
    prompt: Work.
    poll_ms: 60000
    timeout: 6h
`;

const ONE_STEP_ISOLATED = `title: One isolated
isolation: worktree
steps:
  - id: a
    prompt: Work.
    poll_ms: 60000
    timeout: 6h
`;

/** The fixed epoch of the suite: 2026-06-01 (a Monday) in UTC, with no DST in play. */
function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 5, 1, hour, minute);
}

interface World {
  readonly clock: FakeClock;
  readonly home: TempHome;
  readonly repo: TempRepo;
  readonly executor: FakeExecutor;
  readonly host: ArgosHost;
}

const hosts: ArgosHost[] = [];
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

async function makeWorld(
  options: {
    readonly at?: number;
    readonly playbooks?: Readonly<Record<string, string>>;
    /** A manual executor keeps a fired run live; the default finishes it on its first poll. */
    readonly executor?: FakeExecutor;
  } = {},
): Promise<World> {
  const repo = makeRepo(options.playbooks ?? { nightly: ONE_STEP });
  const home = makeTempHome();
  homes.push(home);
  const clock = new FakeClock(options.at ?? at(6, 59));
  const executor = options.executor ?? new FakeExecutor({ completeAfterPolls: 1 });
  const host = await ArgosHost.open({
    storage: new MemoryStorage(),
    home: home.home,
    executor,
    clock,
  });
  hosts.push(host);
  return { clock, home, repo, executor, host };
}

afterEach(async () => {
  while (runners.length > 0) await runners.pop()?.close();
  while (hosts.length > 0) await hosts.pop()?.close();
  while (homes.length > 0) homes.pop()?.cleanup();
  while (repositories.length > 0) repositories.pop()?.cleanup();
});

// ------------------------------------------------------------------ helpers

async function addSchedule(
  world: World,
  input: {
    readonly id?: string;
    readonly playbookId?: string;
    readonly overlap?: "skip" | "allow";
    readonly isolation?: "none" | "worktree";
    readonly keep?: number | "all";
  } = {},
): Promise<ScheduleDoc> {
  return world.host.addSchedule({
    id: input.id ?? "hourly",
    playbookId: input.playbookId ?? "nightly",
    cwd: world.repo.repo,
    // Hourly from 06:59, so every `at(hour)` below is one fire time away from the previous one.
    cron: "0 * * * *",
    tz: "UTC",
    ...(input.overlap === undefined ? {} : { overlap: input.overlap }),
    ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    ...(input.keep === undefined ? {} : { keep: input.keep }),
  });
}

async function schedule(world: World, id: string): Promise<ScheduleDoc> {
  const doc = await world.host.getSchedule(id);
  if (doc === undefined) throw new Error(`schedule ${id} is gone`);
  return doc;
}

/** Move the clock to `at(hour)`, run the tick, and return the run that fire started. */
async function fireRun(world: World, id: string, hour: number): Promise<string> {
  await world.clock.advanceTo(at(hour));
  await world.host.scheduleIdle();
  const lastFire = (await schedule(world, id)).lastFire;
  if (
    lastFire === undefined ||
    lastFire.fireAt !== at(hour) ||
    lastFire.status !== "started" ||
    lastFire.runId === undefined
  ) {
    throw new Error(`the fire at ${hour}:00 did not start a run: ${JSON.stringify(lastFire)}`);
  }
  return lastFire.runId;
}

/** Finish the running agents of one run, so a later prune may remove it (FR9.3). */
function completeAgentsOf(world: World, runId: string): void {
  for (const agent of [...world.executor.agents.values()]) {
    if (agent.runId === runId && agent.status === "running") {
      world.executor.complete(agent.requestId);
    }
  }
}

/** Complete the run's agents, then wait until the run is terminal (FR9.3 needs a finished run). */
async function completeRun(world: World, runId: string): Promise<void> {
  completeAgentsOf(world, runId);
  await drive(
    world.clock,
    async () => {
      const record = (await world.host.getRun(runId))?.record;
      return record !== undefined && isTerminalRunStatus(record.status);
    },
    // A minute per round: a manually completed agent is only noticed on its next poll (FR3.3).
    { stepMs: 60_000, maxRounds: 10 },
  );
}

/** Fire at `hour` and wait for the run it started to finish. */
async function fireCompleted(world: World, id: string, hour: number): Promise<string> {
  const runId = await fireRun(world, id, hour);
  await completeRun(world, runId);
  return runId;
}

/** The `argos.runs` index as it stands, for "the entry is retired too" assertions. */
async function runIndex(world: World): Promise<string[]> {
  const index = await world.host.harness.snapshot(RunsIndexDoc, world.host.context);
  if (index === undefined) return [];
  return index.ids.filter((id): id is string => typeof id === "string");
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

// ------------------------------------------------------------------ keep (FR9.1, FR9.2)

describe("retention removes the runs beyond the newest keep (FR9.1–FR9.3, G7)", () => {
  it("removes 2 of 4 completed runs, with their history documents and index entries", async () => {
    const world = await makeWorld();
    await addSchedule(world, { keep: 2, overlap: "allow" });
    await world.host.scheduleIdle();

    const first = await fireCompleted(world, "hourly", 7);
    const second = await fireCompleted(world, "hourly", 8);
    // Two runs is exactly `keep`: nothing is beyond the newest two yet.
    expect((await schedule(world, "hourly")).runIds).toEqual([second, first]);
    expect(sorted(await runIndex(world))).toEqual(sorted([first, second]));

    const third = await fireCompleted(world, "hourly", 9);
    // FR9.2: `first` is now the third-newest id, so the fire's prune removes it.
    expect(await world.host.getRun(first)).toBeUndefined();
    expect(await world.host.getHistory(first)).toBeUndefined();

    const fourth = await fireCompleted(world, "hourly", 10);
    expect(await world.host.getRun(second)).toBeUndefined();
    expect(await world.host.getHistory(second)).toBeUndefined();

    // The survivors: the newest two runs, their documents, their history, and the index.
    const doc = await schedule(world, "hourly");
    expect(doc.runIds).toEqual([fourth, third]);
    expect(sorted(await runIndex(world))).toEqual(sorted([third, fourth]));
    expect(sorted((await world.host.listRuns()).map((run) => run.record.id))).toEqual(
      sorted([third, fourth]),
    );
    expect(await world.host.getRun(third)).toBeDefined();
    expect(await world.host.getHistory(third)).toBeDefined();
    // FR9.3: retention is decided after the fire's commit and never changes it — the fire log keeps
    // exactly the entries the fires wrote, and `lastFire` is still the last fire's outcome.
    expect(doc.lastFire).toMatchObject({ fireAt: at(10), status: "started", runId: fourth });
    expect(doc.fires.map((entry) => entry.status)).toEqual([
      "started",
      "started",
      "started",
      "started",
    ]);
    expect(doc.consecutiveFailures).toBe(0);
  });

  it("removes nothing while keep is \"all\"", async () => {
    const world = await makeWorld();
    await addSchedule(world, { keep: "all", overlap: "allow" });
    await world.host.scheduleIdle();

    const runs = [
      await fireCompleted(world, "hourly", 7),
      await fireCompleted(world, "hourly", 8),
      await fireCompleted(world, "hourly", 9),
      await fireCompleted(world, "hourly", 10),
    ];

    // FR9.1: `"all"` is "keep every run", so not one candidate exists.
    expect((await schedule(world, "hourly")).runIds).toEqual([...runs].reverse());
    expect(sorted((await world.host.listRuns()).map((run) => run.record.id))).toEqual(sorted(runs));
    for (const runId of runs) {
      expect(await world.host.getRun(runId)).toBeDefined();
      expect(await world.host.getHistory(runId)).toBeDefined();
    }
    expect(sorted(await runIndex(world))).toEqual(sorted(runs));
  });

  it("keeps a live run and tries it again after the next fire", async () => {
    // A manual executor: the fired run never finishes on its own, so it stays live (FR5.2).
    const world = await makeWorld({ executor: new FakeExecutor() });
    await addSchedule(world, { keep: 1, overlap: "allow" });
    await world.host.scheduleIdle();

    const live = await fireRun(world, "hourly", 7);
    const next = await fireRun(world, "hourly", 8);

    // FR9.3: `removeRun` refuses a live run with `run_terminal`, so the id stays in `runIds`.
    const doc = await schedule(world, "hourly");
    expect(doc.runIds).toEqual([next, live]);
    expect(await world.host.getRun(live)).toBeDefined();
    expect((await world.host.getRun(live))?.record.status).toBe("running");

    // Once it finishes, the next fire prunes it like any other old run.
    await completeRun(world, live);
    const third = await fireCompleted(world, "hourly", 9);
    expect(await world.host.getRun(live)).toBeUndefined();
    expect((await schedule(world, "hourly")).runIds).toEqual([third, next]);
  });

  it("drops an id the operator already removed from runIds", async () => {
    const world = await makeWorld();
    await addSchedule(world, { keep: 2, overlap: "allow" });
    await world.host.scheduleIdle();

    const first = await fireCompleted(world, "hourly", 7);
    const second = await fireCompleted(world, "hourly", 8);
    // `argos rm` on a run the schedule still lists: the document is gone, only the id is stale.
    await world.host.removeRun(first);
    expect(await world.host.getRun(first)).toBeUndefined();

    const third = await fireCompleted(world, "hourly", 9);

    // FR9.2: the stale id is dropped without a second `removeRun`; the run inside `keep` is kept.
    const doc = await schedule(world, "hourly");
    expect(doc.runIds).toEqual([third, second]);
    expect(await world.host.getRun(second)).toBeDefined();
    expect(sorted(await runIndex(world))).toEqual(sorted([second, third]));
  });

  it("never prunes an id the runIds cap already dropped (FR9.2)", async () => {
    const world = await makeWorld();
    // The default keep, so the seeded list is far longer than the newest `keep`.
    await addSchedule(world, { overlap: "allow" });
    await world.host.scheduleIdle();

    // One real, finished run: the id sits at the end of the seeded list, so the **cap** — not
    // retention — is what drops it when the next fire prepends its own run id.
    const oldest = await fireCompleted(world, "hourly", 7);

    const before = await schedule(world, "hourly");
    const seeded = Array.from({ length: RUN_IDS_LIMIT - 1 }, (_unused, index) => {
      return `seeded-run-${String(index).padStart(4, "0")}`;
    });
    expect(seeded).toHaveLength(RUN_IDS_LIMIT - 1);
    await world.host.harness.commit(async (tx) => {
      await writeScheduleDoc(tx, { ...before, runIds: [...seeded, oldest] });
    }, world.host.context);

    const newest = await fireCompleted(world, "hourly", 8);

    const doc = await schedule(world, "hourly");
    expect(doc.runIds[0]).toBe(newest);
    // FR9.2: the cap dropped `oldest` while the fire committed, so retention never saw its id…
    expect(doc.runIds).not.toContain(oldest);
    // …and the run itself is untouched: it still exists, with its history and index entry.
    expect(await world.host.getRun(oldest)).toBeDefined();
    expect(await world.host.getHistory(oldest)).toBeDefined();
    expect((await runIndex(world)).includes(oldest)).toBe(true);
    // The ids retention could see (everything past the newest `keep`) are the placeholders, so only
    // they were dropped — the list is the newest run plus the newest `keep - 1` placeholders.
    expect(doc.runIds).toHaveLength(KEEP_DEFAULT);
    expect(doc.runIds.slice(1)).toEqual(seeded.slice(0, KEEP_DEFAULT - 1));
  });
});

// ------------------------------------------------------------------ worktrees (FR9.3)

describe("retention never removes a worktree (FR9.3, FR4)", () => {
  it("skips a run whose worktree directory exists, then prunes it once it is gone", async () => {
    const world = await makeWorld({ playbooks: { isolated: ONE_STEP_ISOLATED } });
    await addSchedule(world, {
      id: "isolated",
      playbookId: "isolated",
      isolation: "worktree",
      keep: 1,
      overlap: "allow",
    });
    await world.host.scheduleIdle();

    const first = await fireCompleted(world, "isolated", 7);
    const worktree = (await world.host.getRun(first))?.record.worktree?.path;
    expect(worktree).toBeDefined();
    if (worktree === undefined) return;
    expect(existsSync(worktree)).toBe(true);

    const second = await fireCompleted(world, "isolated", 8);
    // FR9.3: the directory is still there, so the run is kept — even though it is beyond `keep`.
    expect(await world.host.getRun(first)).toBeDefined();
    expect((await schedule(world, "isolated")).runIds).toEqual([second, first]);
    expect(existsSync(worktree)).toBe(true);

    // The operator removes the checkout (`argos worktree rm`), and the next fire retries the prune.
    rmSync(worktree, { recursive: true, force: true });
    const third = await fireCompleted(world, "isolated", 9);

    expect(await world.host.getRun(first)).toBeUndefined();
    // The newer run's directory still exists, and retention removed neither it nor its branch.
    const kept = (await world.host.getRun(second))?.record.worktree?.path;
    expect(kept).toBeDefined();
    if (kept === undefined) return;
    expect(existsSync(kept)).toBe(true);
    expect((await schedule(world, "isolated")).runIds).toEqual([third, second]);
    // Retention never deletes a branch either — not the survivor's and not the pruned run's.
    expect(world.repo.git(["branch", "--list", `argos/${second}`])).toContain(`argos/${second}`);
    expect(world.repo.git(["branch", "--list", `argos/${first}`])).toContain(`argos/${first}`);
  });
});

// ------------------------------------------------------------------ a failing prune (FR9.3)

describe("a prune that fails never changes the fire (FR9.3)", () => {
  it("keeps a started outcome and its event when removeRun throws", async () => {
    const world = await makeWorld();
    const now = world.clock.now();
    // Written straight into storage: this test drives its own runner, so the host's runner never
    // sees the schedule and `add`'s dry check is not in the way.
    const doc: ScheduleDoc = {
      id: "explosive",
      uid: "schedule-explosive-uid",
      playbookId: "nightly",
      cwd: world.repo.repo,
      inputs: {},
      cron: "0 * * * *",
      tz: "UTC",
      overlap: "skip",
      catchUp: "all",
      keep: 1,
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

    // The honest seam: every other operation is the host's own, only retention's remove fails.
    const runner = new ScheduleRunner({
      harness: world.host.harness,
      context: world.host.context,
      clock: world.clock,
      home: world.home.home,
      port: world.host.startPort,
      runs: {
        get: (runId) => world.host.getRun(runId),
        remove: async () => {
          throw new Error("prune exploded");
        },
      },
    });
    runners.push(runner);
    const events: ScheduleFireEvent[] = [];
    runner.observeScheduleFires((event) => {
      events.push(event);
    });
    await runner.start();

    const first = await fireRun(world, doc.id, 7);
    await completeRun(world, first);
    expect(events.map((event) => event.status)).toEqual(["started"]);

    // The second fire's prune reaches the exploding `remove`.
    const second = await fireRun(world, doc.id, 8);

    const after = await schedule(world, doc.id);
    // FR9.3: the fire's outcome, its log entry, and its event are exactly what the fire wrote.
    expect(after.lastFire).toMatchObject({ fireAt: at(8), status: "started", runId: second });
    expect(after.fires.map((entry) => entry.status)).toEqual(["started", "started"]);
    expect(after.consecutiveFailures).toBe(0);
    expect(events.map((event) => event.status)).toEqual(["started", "started"]);
    expect(events[1]).toMatchObject({ fireAt: at(8), runId: second });
    // The run it could not remove stays on the list and on disk, so the next fire tries again.
    expect(after.runIds).toEqual([second, first]);
    expect(await world.host.getRun(first)).toBeDefined();
  });
});
